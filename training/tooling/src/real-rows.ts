import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { foldState } from "./fold-state";
import { layaFits } from "./laya";
import { splitOf } from "./laya-dataset";
import { indexOf, plainShapeLine, roomShapeLine } from "./room-shape";
import { scrubText } from "./pii";
import { roomKindOf } from "./conversation";
import { synthesisFor } from "./laya-synth";

import type { ArchivedMessage } from "./conversation";
import type { GateSynthesis } from "./laya-synth";
import type { LayaQuestion, LayaRequest, LayaState } from "./laya";
import type { DatasetSplit, SplitShares } from "./laya-dataset";
import type { ShapeWho } from "./room-shape";

// A gate's inputs built out of the rooms' real conversation (docs/gate-data.md, 「The real
// conversation source」). What comes out of here is a row with no answer on it: the state the gate
// would have been given and the questions it would have been asked. The answer is a judgement and
// is made afresh on a road, because the gates' prompts and their structure have moved and the
// verdicts the record holds were given by gates that no longer exist.
//
// Nothing here reads the brain. A gate's candidates are what that room was really offered, read
// back out of the probe inputs the verdict record kept, because a library moves and a row written
// against today's brain would be a row no turn of that room ever saw.

// A row before it has been judged. It is the frozen row's own shape less the gold, so a judged row
// is this row with the gold written onto it and nothing else changed.
export interface UnjudgedRow {
  id: string;
  gate: string;
  split: DatasetSplit;
  state: LayaState;
  questions: Record<string, LayaQuestion>;
  // What the judge reads in place of the state, for a gate whose state is a reduction of something
  // the judge can read whole. The judgement is made on the whole and taught against the reduction,
  // which is what the gate will be handed when it runs.
  teacher?: LayaState;
}

// Where a row's material came from. A row built out of a room's own talk and one written by a
// model to fill a gate the rooms could not fill are not the same evidence, and the figures are
// read off the first alone.
export type RowSource = "conversation" | "local";

export interface RealWho extends ShapeWho {
  agentId: number;
}

export interface RealSettings {
  who: RealWho;
  shares: SplitShares;
  // How many rows one gate takes at most, so a count can be made cheaply and a smoke build can ask
  // for a hundred.
  limit: number;
}

// The row's own name, which is its input's hash, and the split that hash fixes. Two turns that
// come to the same input are one row, so a room repeating itself does not weight itself twice.
export function unjudgedRowOf(gate: string, state: LayaState, questions: Record<string, LayaQuestion>, shares: SplitShares): UnjudgedRow {
  const request: LayaRequest = { state, questions };
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");

  return { id: `${gate}:${hash.slice(0, 16)}`, gate, split: splitOf(hash, shares), state, questions };
}

// The newest lines that still fit one Laya call, oldest first to be left out. This is how every
// gate that reads a room's recent messages is given them, so the rows are cut the same way.
export function newestFitting(lines: readonly string[], build: (kept: readonly string[]) => LayaRequest): string[] {
  if (!layaFits(build([]))) {
    return [];
  }

  let taken = 0;

  while (taken < lines.length && layaFits(build(lines.slice(lines.length - taken - 1)))) {
    taken += 1;
  }

  return [...lines.slice(lines.length - taken)];
}

// One gate's specification, which is where every shape a row is held to is written down.
function specOf(gate: string): GateSynthesis {
  const spec = synthesisFor(gate);

  if (spec === null) {
    throw new Error(`${gate} is not a gate this tooling knows.`);
  }

  return spec;
}

// One gate's question as it always asks it, out of the gate's own specification, so no question's
// wording is written here a second time.
function questionsOf(gate: string): Record<string, LayaQuestion> {
  const spec = specOf(gate);

  return Object.fromEntries(spec.questions.map((question) => [
    question.id,
    question.type === "noul"
      ? { type: "noul" as const, instructions: question.instructions }
      : { type: "choice" as const, instructions: question.instructions, criteria: question.options ?? {} },
  ]));
}

// The turn one message stands at the end of: the run of messages before it that nobody has
// answered yet, which is the batch the chat agent would have been given. A gap longer than the turn's own
// stands for the conversation having moved on.
export function turnEndingAt(room: readonly ArchivedMessage[], at: number, agentId: number, gapSeconds: number): ArchivedMessage[] {
  const turn = [room[at]!];

  for (let back = at - 1; back >= 0; back -= 1) {
    const one = room[back]!;

    if (one.senderId === agentId || turn[0]!.sentAt - one.sentAt > gapSeconds || turn.length >= 10) {
      break;
    }

    turn.unshift(one);
  }

  return turn;
}

function hasText(message: ArchivedMessage): boolean {
  return typeof message.text === "string" && message.text.trim() !== "";
}

// The reply-or-not gate: the room's recent messages, the message being judged handed over separately,
// and the kind of room. The chat agent's own messages stand in these lines: a message following its own
// answer is exactly the case this gate has to judge.
export function replyWantedRows(room: readonly ArchivedMessage[], settings: RealSettings): UnjudgedRow[] {
  const gate = "reply-wanted";
  const questions = questionsOf(gate);
  const kind = roomKindOf(room[0]?.chatId ?? 0, settings.who.ownerId);
  const rows: UnjudgedRow[] = [];
  const index = indexOf(room);
  const lines = room.map((one) => roomShapeLine(one, index, settings.who));

  for (const [at, one] of room.entries()) {
    if (rows.length >= settings.limit) {
      break;
    }

    if (one.senderId === settings.who.agentId || !hasText(one)) {
      continue;
    }

    const message = lines[at]!;
    const before = lines.slice(Math.max(0, at - 24), at);
    const recent = newestFitting(before, (kept) => ({ state: { room: kind, recent: [...kept], message }, questions }));

    // A turn with nothing in front of it is not this gate's input: the gate reads the room's recent
    // messages beside the one it judges, and a row whose transcript is empty is refused by the
    // gate's own specification. Leaving it out here is what stops a judgement being bought for it.
    if (recent.length === 0) {
      continue;
    }

    rows.push(unjudgedRowOf(gate, { room: kind, recent, message }, questions, settings.shares));
  }

  return rows;
}

// The output format gate: the markdown the chat agent wrote, what the reader saw of it and whether it went out folded. What
// people received is the record of that judgement, and it outlives every log.
export interface SentRow {
  original: string;
  visible: string;
  folded: boolean;
}

// The gate is shown the message reduced to its opening, its closing and its counts, so a message of
// any length is a row; the judge reads the markdown whole. A message with no line break and no more
// than 120 characters never reaches the gate, and is not a row of it either.
export function outputFormatRows(sent: readonly SentRow[], settings: RealSettings): UnjudgedRow[] {
  const gate = "output-format";
  const questions = questionsOf(gate);
  const rows: UnjudgedRow[] = [];

  for (const one of sent) {
    if (rows.length >= settings.limit) {
      break;
    }

    const original = scrubText(one.original);

    if (original.trim() === "" || (!original.includes("\n") && original.length <= 120)) {
      continue;
    }

    const state = foldState(original);

    if (!layaFits({ state, questions })) {
      continue;
    }

    rows.push({ ...unjudgedRowOf(gate, state, questions, settings.shares), teacher: { message: original } });
  }

  return rows;
}

// Where a gate's unjudged rows stand in its own folder, beside the batches a judging pass freezes.
export const unjudgedFile = "unjudged.jsonl";

// A gate's unjudged rows, read out of its own folder.
export function readUnjudged(folder: string): UnjudgedRow[] {
  return readFileSync(join(folder, unjudgedFile), "utf8")
    .split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as UnjudgedRow);
}

// What the build settled, written once in the run's own root so the judging pass reads it back
// rather than being told it again. The splits are fixed when a row is built, and a judging pass
// given different shares would write a meta that disagrees with the rows under it — which is the
// one thing the merge refuses a dataset for.
export const realMetaFile = "real.meta.json";

export interface RealMeta {
  built: string;
  seed: string;
  limit: number;
  shares: SplitShares;
  gates: string[];
}

// What this source reads of the conversation, and the whole of it. A caller wires these to the snapshot;
// a test wires them to rooms of its own and opens no database, which is what keeps the builders
// above testable without a copy of a year of conversation.
export interface ConversationReads {
  rooms(): number[];
  messages(chatId: number): ArchivedMessage[];
  sent(): SentRow[];
}

// The gates this source builds rows for. A gate not named here has no material in the rooms and is
// written on a road instead.
export const realSourceGates = ["reply-wanted", "output-format"] as const;

// Every gate's rows, built room by room. A gate the rooms hold nothing for comes back with none
// rather than being left out, so a count says the same thing about every gate.
export function realRows(reads: ConversationReads, settings: RealSettings, gates: readonly string[]): Map<string, UnjudgedRow[]> {
  const built = new Map<string, UnjudgedRow[]>(gates.map((gate) => [gate, []]));

  for (const gate of gates) {
    const rows = built.get(gate)!;

    if (gate === "output-format") {
      rows.push(...outputFormatRows(reads.sent(), settings));
      continue;
    }

    for (const chatId of reads.rooms()) {
      if (rows.length >= settings.limit) {
        break;
      }

      const room = reads.messages(chatId);
      const left = { ...settings, limit: settings.limit - rows.length };

      if (gate === "reply-wanted") {
        rows.push(...replyWantedRows(room, left));
      }
    }
  }

  return built;
}
