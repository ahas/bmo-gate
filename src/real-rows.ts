import { createHash } from "node:crypto";

import { layaFits } from "./laya";
import { splitOf } from "./laya-dataset";
import { indexOf, plainShapeLine, roomShapeLine } from "./room-shape";
import { scrubText } from "./pii";
import { roomKindOf } from "./archive";
import { candidateOf, synthesisFor } from "./laya-synth";

import type { ArchivedMessage, RecordedQuestions } from "./archive";
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
}

// Where a row's material came from. A row built out of a room's own talk and one written by a
// model to fill a gate the rooms could not fill are not the same evidence, and the figures are
// read off the first alone.
export type RowSource = "archive" | "j3090";

export interface RealWho extends ShapeWho {
  bmoId: number;
}

export interface RealSettings {
  who: RealWho;
  shares: SplitShares;
  // How many rows one gate takes at most, so a count can be made cheaply and a smoke build can ask
  // for a hundred.
  limit: number;
  // How far apart two messages may stand and still be one turn, in seconds.
  turnGapSeconds?: number;
}

const defaultTurnGapSeconds = 600;

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
    throw new Error(`${gate} 는 이 저장소가 아는 게이트가 아닙니다.`);
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
// answered yet, which is the batch BMO would have been given. A gap longer than the turn's own
// stands for the conversation having moved on.
function turnEndingAt(room: readonly ArchivedMessage[], at: number, bmoId: number, gapSeconds: number): ArchivedMessage[] {
  const turn = [room[at]!];

  for (let back = at - 1; back >= 0; back -= 1) {
    const one = room[back]!;

    if (one.senderId === bmoId || turn[0]!.sentAt - one.sentAt > gapSeconds || turn.length >= 10) {
      break;
    }

    turn.unshift(one);
  }

  return turn;
}

function hasText(message: ArchivedMessage): boolean {
  return typeof message.text === "string" && message.text.trim() !== "";
}

// 응답 여부 판정기 — the room's recent messages, the message being judged handed over separately,
// and the kind of room. BMO's own messages stand in these lines: a message following BMO's own
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

    if (one.senderId === settings.who.bmoId || !hasText(one)) {
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

// 답변 내용 게이트 — the kind of room, as many of the room's latest messages as fit beside the
// answer, and the candidate answer whole. The answer is one BMO really gave, which is the only
// candidate answer the archive holds.
export function contentJudgeRows(room: readonly ArchivedMessage[], settings: RealSettings): UnjudgedRow[] {
  const gate = "content-judge";
  const questions = questionsOf(gate);
  const kind = roomKindOf(room[0]?.chatId ?? 0, settings.who.ownerId);
  const rows: UnjudgedRow[] = [];
  const index = indexOf(room);
  const lines = room.map((one) => roomShapeLine(one, index, settings.who));

  for (const [at, one] of room.entries()) {
    if (rows.length >= settings.limit) {
      break;
    }

    if (one.senderId !== settings.who.bmoId || !hasText(one)) {
      continue;
    }

    const answer = scrubText(one.text);
    const before = lines.slice(Math.max(0, at - 24), at);
    const recent = newestFitting(before, (kept) => ({ state: { room: kind, recent: [...kept], answer }, questions }));

    // An answer that does not fit on its own is past the gate's reach and is not a row, and an
    // answer with no room in front of it is not this gate's input either.
    if (recent.length === 0 || !layaFits({ state: { room: kind, recent: [], answer }, questions })) {
      continue;
    }

    rows.push(unjudgedRowOf(gate, { room: kind, recent, answer }, questions, settings.shares));
  }

  return rows;
}

// 출력 서식 — the answer as its reader saw it, the markdown it was converted from, and whether it
// went out folded. What people received is the record of that judgement, and it outlives every log.
export interface SentRow {
  original: string;
  visible: string;
  folded: boolean;
}

export function outputFormatRows(sent: readonly SentRow[], settings: RealSettings): UnjudgedRow[] {
  const gate = "output-format";
  const questions = questionsOf(gate);
  const rows: UnjudgedRow[] = [];

  for (const one of sent) {
    if (rows.length >= settings.limit) {
      break;
    }

    const state = { original: scrubText(one.original), candidate: scrubText(one.visible), folded: one.folded };

    if (state.original.trim() === "" || !layaFits({ state, questions })) {
      continue;
    }

    rows.push(unjudgedRowOf(gate, state, questions, settings.shares));
  }

  return rows;
}

// The gates that ask one question per candidate, and the shape their state takes. What they are
// offered is the room's own library as that room was really offered it.
const referenceGates = ["system-documents", "room-rules", "library-knowledge", "people-search"] as const;

export type ReferenceGate = (typeof referenceGates)[number];

export function isReferenceGate(gate: string): gate is ReferenceGate {
  return (referenceGates as readonly string[]).includes(gate);
}

// One recorded set's candidates, in the order the record names them, each with the question ids it
// was asked under. A slug the record asked something other than this gate's own questions of is not
// a candidate of this gate and is left out.
function candidatesIn(gate: GateSynthesis, set: Record<string, LayaQuestion>): { slug: string; ids: string[] }[] {
  const order: string[] = [];
  const asked = new Map<string, string[]>();

  for (const id of Object.keys(set)) {
    const named = candidateOf(gate, id);

    if (named === null) {
      continue;
    }

    const held = asked.get(named.slug);

    if (held === undefined) {
      order.push(named.slug);
      asked.set(named.slug, [id]);
    } else {
      held.push(id);
    }
  }

  return order
    .map((slug) => ({ slug, ids: asked.get(slug)! }))
    .filter((one) => one.ids.length === gate.questions.length);
}

// The sets one recorded set really stands for, each holding as many candidates as the gate says it
// offers (docs/laya-gates.md, 「Candidates per row」). A room's record holds every candidate that
// room was ever offered, which for the person book runs to dozens, and the gate itself is never
// handed more than its own maximum — so a row carrying the lot is a row no turn of that gate ever
// saw, and the gate's own specification refuses it outright.
//
// The candidates are cut into groups of the gate's maximum. A remainder short of the minimum
// reaches back over the group before it rather than being dropped, so every candidate the room was
// offered stands in some set and the overlap costs only a candidate being asked about twice.
export function offeredSets(gate: GateSynthesis, set: Record<string, LayaQuestion>): Record<string, LayaQuestion>[] {
  const range = gate.candidates;

  if (range === null) {
    return Object.keys(set).length === 0 ? [] : [set];
  }

  const candidates = candidatesIn(gate, set);

  if (candidates.length < range.min) {
    return [];
  }

  const sets: Record<string, LayaQuestion>[] = [];

  for (let at = 0; at < candidates.length; at += range.max) {
    const taken = candidates.length - at < range.min
      ? candidates.slice(candidates.length - range.min)
      : candidates.slice(at, at + range.max);

    sets.push(Object.fromEntries(taken.flatMap((one) => one.ids.map((id) => [id, set[id]!]))));
  }

  return sets;
}

// The candidate sets one gate really offered, kept per room and cut to what the gate offers. A room
// with none offered the gate nothing that was ever recorded, and no row of that gate is built from
// its turns.
export function candidateSetsByRoom(gate: GateSynthesis, recorded: readonly RecordedQuestions[]): Map<number, Record<string, LayaQuestion>[]> {
  const byRoom = new Map<number, Record<string, LayaQuestion>[]>();

  for (const one of recorded) {
    const sets = offeredSets(gate, one.questions as Record<string, LayaQuestion>);

    if (sets.length === 0) {
      continue;
    }

    const held = byRoom.get(one.chatId) ?? [];

    held.push(...sets);
    byRoom.set(one.chatId, held);
  }

  return byRoom;
}

// A reference gate's rows: the turn's messages in the plain shape, and one of the candidate sets
// that room was really offered. Which set a turn takes is fixed by the turn itself, so the same
// archive read twice builds the same rows.
export function referenceRows(
  gate: ReferenceGate,
  room: readonly ArchivedMessage[],
  sets: readonly Record<string, LayaQuestion>[],
  settings: RealSettings,
): UnjudgedRow[] {
  const rows: UnjudgedRow[] = [];
  const gap = settings.turnGapSeconds ?? defaultTurnGapSeconds;

  if (sets.length === 0) {
    return rows;
  }

  for (const [at, one] of room.entries()) {
    if (rows.length >= settings.limit) {
      break;
    }

    // A turn is judged when its last message is in, and BMO's own words are taken out of the lines
    // these gates read: they are picking documents about the people who spoke.
    if (one.senderId === settings.who.bmoId || !hasText(one)) {
      continue;
    }

    const next = room[at + 1];

    if (next !== undefined && next.senderId !== settings.who.bmoId && next.sentAt - one.sentAt <= gap) {
      continue;
    }

    const turn = turnEndingAt(room, at, settings.who.bmoId, gap);
    const state = turn.map((message) => plainShapeLine(message, settings.who)).join("\n");
    const questions = sets[Number(BigInt(`0x${createHash("sha256").update(state).digest("hex").slice(0, 8)}`) % BigInt(sets.length))]!;

    if (!layaFits({ state, questions })) {
      continue;
    }

    rows.push(unjudgedRowOf(gate, state, questions, settings.shares));
  }

  return rows;
}

// 상황 규칙 매칭기 — the room's recent messages in the room shape as the situation, and the room's
// standing rules as candidates, both halves of each rule named by its own slug.
export function situationRows(
  room: readonly ArchivedMessage[],
  sets: readonly Record<string, LayaQuestion>[],
  settings: RealSettings,
): UnjudgedRow[] {
  const gate = "situation-rules";
  const rows: UnjudgedRow[] = [];
  const kind = roomKindOf(room[0]?.chatId ?? 0, settings.who.ownerId);
  const index = indexOf(room);
  const lines = room.map((one) => roomShapeLine(one, index, settings.who));

  if (sets.length === 0) {
    return rows;
  }

  for (const [at, one] of room.entries()) {
    if (rows.length >= settings.limit) {
      break;
    }

    if (one.senderId === settings.who.bmoId || !hasText(one)) {
      continue;
    }

    const before = lines.slice(Math.max(0, at - 12), at + 1);
    const questions = sets[at % sets.length]!;
    const situation = newestFitting(before, (kept) => ({ state: { room: kind, situation: [...kept] }, questions }));

    if (situation.length === 0) {
      continue;
    }

    rows.push(unjudgedRowOf(gate, { room: kind, situation }, questions, settings.shares));
  }

  return rows;
}

// Where a gate's unjudged rows stand in its own folder, beside the batches a judging pass freezes.
export const unjudgedFile = "unjudged.jsonl";

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

// What this source reads of the archive, and the whole of it. A caller wires these to the archive;
// a test wires them to rooms of its own and opens no database, which is what keeps the builders
// above testable without a copy of a year of conversation.
export interface ArchiveReads {
  rooms(): number[];
  messages(chatId: number): ArchivedMessage[];
  recorded(stage: string): RecordedQuestions[];
  sent(): SentRow[];
}

// The gates this source builds rows for. A gate not named here has no material in the rooms and is
// written on a road instead; which those are is the count's to say, not this list's.
export const realSourceGates = [
  "reply-wanted", "content-judge", "output-format", "situation-rules", ...referenceGates,
] as const;

// Every gate's rows, built room by room. A gate the rooms hold nothing for comes back with none
// rather than being left out, so a count says the same thing about every gate.
export function realRows(reads: ArchiveReads, settings: RealSettings, gates: readonly string[]): Map<string, UnjudgedRow[]> {
  const built = new Map<string, UnjudgedRow[]>(gates.map((gate) => [gate, []]));

  for (const gate of gates) {
    const rows = built.get(gate)!;

    if (gate === "output-format") {
      rows.push(...outputFormatRows(reads.sent(), settings));
      continue;
    }

    const sets = isReferenceGate(gate) || gate === "situation-rules"
      ? candidateSetsByRoom(specOf(gate), reads.recorded(gate))
      : new Map<number, Record<string, LayaQuestion>[]>();

    for (const chatId of reads.rooms()) {
      if (rows.length >= settings.limit) {
        break;
      }

      const room = reads.messages(chatId);
      const left = { ...settings, limit: settings.limit - rows.length };

      if (gate === "reply-wanted") {
        rows.push(...replyWantedRows(room, left));
      } else if (gate === "content-judge") {
        rows.push(...contentJudgeRows(room, left));
      } else if (gate === "situation-rules") {
        rows.push(...situationRows(room, sets.get(chatId) ?? [], left));
      } else if (isReferenceGate(gate)) {
        rows.push(...referenceRows(gate, room, sets.get(chatId) ?? [], left));
      }
    }
  }

  return built;
}
