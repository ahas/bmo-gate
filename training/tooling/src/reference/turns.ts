import { turnEndingAt } from "../real-rows";

import type { Database } from "bun:sqlite";
import type { ArchivedMessage } from "../conversation";
import type { ReferenceGate } from "./labels";

// The turns the reference gates' data is made of (docs/reference-data.md, 「The turns」): every run of
// messages the chat agent answered together, and every run its own instructions opened, with the answer it gave
// and, where anything says, what reached its prompt. Everything here reads what the snapshot reads
// hands it, so each rule is driven from a test.

// How far a reply may stand from the turn it answers, and how far apart two messages of one turn.
export const replyBoundSeconds = 1_800;
export const turnGapSeconds = 600;

export const turnSources = ["run", "record", "answered", "instructions", "work"] as const;
export type TurnSource = typeof turnSources[number];

export function isTurnSource(name: string): name is TurnSource {
  return (turnSources as readonly string[]).includes(name);
}

// One row of the gate's per-candidate reference record.
export interface RecordedPick {
  gate: ReferenceGate;
  slug: string;
  llm: boolean;
  // Null where the record did not say whether the piece reached the prompt.
  attached: boolean | null;
}

export interface ReferenceTurn {
  key: string;
  chatId: number;
  messageIds: number[];
  // When its last message was sent, in seconds.
  at: number;
  source: TurnSource;
  // The slugs that reached the prompt, or null where nothing says.
  attached: ReadonlySet<string> | null;
  reply: string;
  recorded: RecordedPick[];
  // The bot's own instructions the turn run was handed, as its prompt carries them, where it was
  // handed any; on a turn they opened with no message, they are all its lines.
  instructions?: string;
  // On a piece of work the chat agent handed out, its words, which stand in place of messages.
  work?: WorkWords;
}

// A piece of work's words as its own run hands them to the knowledge gate (the gate's
// `docs/reference-selection.md`, 「Work beyond a turn」): a job's item, or a search's question.
export type WorkWords =
  | { kind: "job"; title: string; instruction: string; requester: string; requesterId: number | null }
  | { kind: "search"; query: string };

// One finished piece of work as the snapshot holds it: what it was asked and what it answered.
export interface WorkRecord {
  key: string;
  chatId: number;
  // When it finished, in seconds.
  at: number;
  work: WorkWords;
  reply: string;
}

// One turn run's scope: the room and the messages it answers, off its scope line, and the bot's own
// instructions it was handed, off its quiet-instruction block, empty where there were none.
export interface TurnScope {
  run: string;
  chatId: number;
  messageIds: number[];
  instructions: string;
  // When the run was handed its prompt, in seconds.
  at: number;
}

export interface TurnReads {
  rooms(): number[];
  room(chatId: number): ArchivedMessage[];
  scopes(): TurnScope[];
  // The slugs a turn run's context lines name, by run.
  contexts(): ReadonlyMap<string, ReadonlySet<string>>;
  recorded(): ReadonlyMap<string, RecordedPick[]>;
  // What a turn run answered, its text lines in order, by run.
  answers(): ReadonlyMap<string, readonly string[]>;
  // Every finished job and search, with its report or its document.
  works(): WorkRecord[];
}

export interface TurnBuild {
  turns: ReferenceTurn[];
  skipped: { noReply: number; noMessage: number; noText: number };
}

export function turnKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

// The reply to the message at `at`: the first run of the chat agent's own messages after it, inside the bound,
// up to the next message somebody else sends.
export function replyAfter(room: readonly ArchivedMessage[], at: number, agentId: number, boundSeconds = replyBoundSeconds): string | null {
  const asked = room[at]!;
  let start = -1;

  for (let next = at + 1; next < room.length; next += 1) {
    const one = room[next]!;

    if (one.sentAt - asked.sentAt > boundSeconds) {
      break;
    }

    if (one.senderId === agentId) {
      start = next;
      break;
    }
  }

  if (start < 0) {
    return null;
  }

  const said: string[] = [];

  for (let next = start; next < room.length && room[next]!.senderId === agentId; next += 1) {
    if (room[next]!.text.trim() !== "") {
      said.push(room[next]!.text);
    }
  }

  return said.length === 0 ? null : said.join("\n\n");
}

// What the record says reached the prompt, where every one of its yes answers says.
function recordedAttached(picks: readonly RecordedPick[]): ReadonlySet<string> | null {
  if (picks.length === 0 || picks.some((one) => one.llm && one.attached === null)) {
    return null;
  }

  return new Set(picks.filter((one) => one.attached === true).map((one) => one.slug));
}

// A turn the bot's own instructions opened, named by its run: its reply is what the run answered,
// `<<SKIP>>` included, since such an answer sends nothing to the room to be read back from it.
function instructionTurn(scope: TurnScope, answered: readonly string[], attached: ReadonlySet<string>): ReferenceTurn | null {
  const said = answered.filter((text) => text.trim() !== "");

  if (said.length === 0) {
    return null;
  }

  return {
    key: scope.run,
    chatId: scope.chatId,
    messageIds: [],
    at: scope.at,
    source: "instructions",
    attached,
    reply: said.join("\n\n"),
    recorded: [],
    instructions: scope.instructions,
  };
}

// Every turn, newest first. A turn run's scope line names its messages exactly; an answered run no
// scope line claims, from before those lines were written, is rebuilt the way the gates cut a turn;
// a run the bot's own instructions opened is a turn of its own.
export function readTurns(reads: TurnReads, agentId: number): TurnBuild {
  const read = reads.scopes();
  const scopes = read.filter((one) => one.messageIds.length > 0);
  const contexts = reads.contexts();
  const recorded = reads.recorded();
  const answers = reads.answers();
  const scopedRooms = new Map<number, TurnScope[]>();

  for (const scope of scopes) {
    scopedRooms.set(scope.chatId, [...scopedRooms.get(scope.chatId) ?? [], scope]);
  }

  const turns = new Map<string, ReferenceTurn>();
  const skipped = { noReply: 0, noMessage: 0, noText: 0 };

  for (const chatId of reads.rooms()) {
    const room = reads.room(chatId);
    const at = new Map(room.map((one, index) => [one.messageId, index]));
    const claimed = new Set<number>();
    const add = (messageIds: number[], source: TurnSource, attached: ReadonlySet<string> | null, instructions = ""): void => {
      const last = at.get(messageIds.at(-1)!)!;
      const key = turnKey(chatId, room[last]!.messageId);

      if (instructions.trim() === "" && messageIds.every((id) => room[at.get(id)!]!.text.trim() === "")) {
        skipped.noText += 1;
        return;
      }

      const reply = replyAfter(room, last, agentId);

      if (reply === null) {
        skipped.noReply += 1;
        return;
      }

      const picks = recorded.get(key) ?? [];

      turns.set(key, {
        key, chatId, messageIds, at: room[last]!.sentAt, source,
        attached: attached ?? recordedAttached(picks),
        reply, recorded: picks,
        ...instructions.trim() === "" ? {} : { instructions },
      });
    };

    // The scope lines, a later run of the same messages standing for them.
    for (const scope of scopedRooms.get(chatId) ?? []) {
      if (!scope.messageIds.every((id) => at.has(id))) {
        skipped.noMessage += 1;
        continue;
      }

      const ordered = [...scope.messageIds].sort((left, right) => at.get(left)! - at.get(right)!);

      for (const id of ordered) {
        claimed.add(id);
      }

      add(ordered, "run", contexts.get(scope.run) ?? new Set(), scope.instructions);
    }

    // The runs before the first scope line of the room: after it, every turn the chat agent took wrote one, and a
    // run of its own messages no scope names is a notice it gave unprompted.
    const firstScoped = Math.min(...(scopedRooms.get(chatId) ?? []).map((scope) => room[at.get(scope.messageIds[0]!) ?? 0]?.sentAt ?? Infinity));

    for (let index = 1; index < room.length; index += 1) {
      const one = room[index]!;
      const before = room[index - 1]!;

      if (one.senderId !== agentId || before.senderId === agentId || one.sentAt >= firstScoped || claimed.has(before.messageId)) {
        continue;
      }

      const messages = turnEndingAt(room, index - 1, agentId, turnGapSeconds);

      if (messages.some((message) => claimed.has(message.messageId)) || turns.has(turnKey(chatId, before.messageId))) {
        continue;
      }

      add(messages.map((message) => message.messageId), "answered", null);
    }

    // A message the gates were asked about whose turn run never wrote its scope — it fell over and the
    // message was answered with the ones after it — is a turn of its own on the record's word.
    for (const key of recorded.keys()) {
      const [chat, message] = key.split(":").map(Number);
      const index = chat === chatId ? at.get(message!) : undefined;

      if (index === undefined || turns.has(key)) {
        continue;
      }

      add(turnEndingAt(room, index, agentId, turnGapSeconds).map((one) => one.messageId), "record", null);
    }
  }

  for (const scope of read) {
    if (scope.messageIds.length > 0 || scope.instructions.trim() === "") {
      continue;
    }

    const turn = instructionTurn(scope, answers.get(scope.run) ?? [], contexts.get(scope.run) ?? new Set());

    if (turn === null) {
      skipped.noReply += 1;
      continue;
    }

    turns.set(turn.key, turn);
  }

  // A piece of work: what attached to it is not known, so every piece is judged with the two words.
  for (const one of reads.works()) {
    if (one.reply.trim() === "") {
      skipped.noReply += 1;
      continue;
    }

    turns.set(one.key, { key: one.key, chatId: one.chatId, messageIds: [], at: one.at, source: "work", attached: null, reply: one.reply, recorded: [], work: one.work });
  }

  return { turns: [...turns.values()].sort((left, right) => right.at - left.at), skipped };
}

// The piece a context line names: a path whose last part is the piece's slug, or a root document's
// file name, which is its slug in upper case.
export function contextSlug(text: string): string {
  return (text.split("/").at(-1) ?? text).replace(/\.md$/i, "").toLowerCase();
}

// The bot's own instructions a turn prompt carries in its quiet-instruction block, as they were
// handed: a scope line that leaves them out leaves them to that block. Empty where it has none.
export function quietInstructions(prompt: string): string {
  const block = /^Quiet instruction from the system \(\d+\):\n([\s\S]*?)\nEND OF QUIET INSTRUCTION$/m.exec(prompt);

  return block?.[1] ?? "";
}

// The same reads over a conversation snapshot (`snapshot.ts`), opened read-only. Its agent log holds the
// chat agent's runs alone, and a search's document stands in it as the text the search answered.
export function snapshotTurnReads(
  db: Database,
  rooms: () => number[],
  room: (chatId: number) => ArchivedMessage[],
): TurnReads {
  return {
    rooms,
    room,
    scopes: () => {
      const read: TurnScope[] = [];

      for (const one of db.query(`SELECT run, at, substr(text, 1, instr(text || char(10), char(10)) - 1) AS line, text FROM agent_log
          WHERE kind = 'prompt' AND text LIKE 'TURN SCOPE:%' ORDER BY id`).all() as { run: string; at: number; line: string; text: string }[]) {
        try {
          const scope = JSON.parse(one.line.slice("TURN SCOPE:".length)) as { chatId?: number; messageIds?: number[]; instructions?: unknown };

          if (typeof scope.chatId === "number" && Array.isArray(scope.messageIds)) {
            read.push({
              run: one.run,
              chatId: scope.chatId,
              messageIds: scope.messageIds.filter((id) => typeof id === "number"),
              instructions: typeof scope.instructions === "string" ? scope.instructions : quietInstructions(one.text),
              at: one.at,
            });
          }
        } catch {
          // A scope line that does not read names no message.
        }
      }

      return read;
    },
    contexts: () => {
      const pieces = new Map<string, Set<string>>();

      for (const one of db.query(`SELECT run, text FROM agent_log WHERE kind = 'context'
          AND name IN ('document', 'knowledge', 'rule', 'person')`).all() as { run: string; text: string }[]) {
        pieces.set(one.run, (pieces.get(one.run) ?? new Set()).add(contextSlug(one.text)));
      }

      return pieces;
    },
    recorded: () => {
      const picks = new Map<string, RecordedPick[]>();

      for (const one of db.query(`SELECT stage, chat_id AS chatId, message_id AS messageId, slug, llm, attached
          FROM reference_verdicts WHERE message_id IS NOT NULL
          AND stage IN ('system-documents', 'room-rules', 'library-knowledge', 'people-search') ORDER BY id`).all() as
          { stage: ReferenceGate; chatId: number; messageId: number; slug: string; llm: number | null; attached: number | null }[]) {
        const key = turnKey(one.chatId, one.messageId);
        const held = (picks.get(key) ?? []).filter((pick) => !(pick.gate === one.stage && pick.slug === one.slug));

        picks.set(key, [...held, { gate: one.stage, slug: one.slug, llm: one.llm === 1, attached: one.attached === null ? null : one.attached === 1 }]);
      }

      return picks;
    },
    answers: () => {
      const said = new Map<string, string[]>();

      for (const one of db.query(`SELECT run, text FROM agent_log WHERE kind = 'text' ORDER BY id`).all() as
          { run: string; text: string }[]) {
        const held = said.get(one.run) ?? [];

        held.push(one.text);
        said.set(one.run, held);
      }

      return said;
    },
    works: () => [
      ...(db.query(`SELECT id, chat_id AS chatId, title, coalesce(instruction, '') AS instruction, requester, requester_id AS requesterId,
          report, coalesce(done_at, created_at) AS at FROM todos
          WHERE done = 1 AND chat_id IS NOT NULL AND merged_into IS NULL AND report IS NOT NULL ORDER BY id`).all() as
          { id: number; chatId: number; title: string; instruction: string; requester: string; requesterId: number | null; report: string; at: number }[])
        .map((one): WorkRecord => ({
          key: `job:${one.id}`, chatId: one.chatId, at: one.at, reply: one.report,
          work: { kind: "job", title: one.title, instruction: one.instruction, requester: one.requester, requesterId: one.requesterId },
        })),
      ...(db.query(`SELECT id, chat_id AS chatId, query, document, coalesce(finished_at, started_at) AS at FROM searches
          WHERE kind = 'search' AND status = 'done' AND chat_id IS NOT NULL AND document IS NOT NULL ORDER BY id`).all() as
          { id: number; chatId: number; query: string; document: string; at: number }[])
        .map((one): WorkRecord => ({
          key: `search:${one.id}`, chatId: one.chatId, at: one.at, reply: one.document, work: { kind: "search", query: one.query },
        })),
    ],
  };
}
