import { existsSync, readFileSync, appendFileSync } from "node:fs";

import { jsonArrayIn, jsonObjectsIn } from "../laya-teach";
import { labelKey } from "./labels";
import { stratumOf } from "./rows";

import type { Database } from "bun:sqlite";
import type { Label } from "./labels";
import type { InputsAsk, LiveTurn } from "./live-inputs";
import type { WorkWords } from "./turns";

// The knowledge gate's work labels distilled from a teacher (docs/reference-data.md, 「Distilled work
// labels」): every piece of work the snapshot holds, the input the gate builds for it, and a teacher asked which
// of the pieces offered the work needs, before the work ran. Everything here is pure but the snapshot's
// reads: the road, the inputs and the rewriting are handed in, so each rule is driven from a test.

// The one gate a piece of work is asked on.
export const distilledGate = "library-knowledge";

// The bounds of one batch, and of a request and a body as the teacher reads them.
export const requestLimit = 6_000;
export const bodyLimit = 8_000;
export const worksPerBatch = 6;

// A piece of work as the teacher and the gate's code are asked about it. A job with no item behind it is
// asked as its own text on a line of the bot's, which is the line a search's question stands on.
export interface WorkInput {
  key: string;
  chatId: number;
  // When it was asked, in seconds.
  at: number;
  kind: "job" | "search";
  words: WorkWords;
}

// Every piece of work the snapshot holds, newest first: each item that was not merged into another,
// each distinct text of a job run with no item, and each search's question. One text asked twice in a
// room is one piece of work.
export function snapshotWorks(db: Database): WorkInput[] {
  const items = (db.query(`SELECT id, chat_id AS chatId, title, coalesce(instruction, '') AS instruction, coalesce(requester, '') AS requester,
      requester_id AS requesterId, created_at AS at FROM todos WHERE chat_id IS NOT NULL AND merged_into IS NULL ORDER BY id`).all() as
      { id: number; chatId: number; title: string; instruction: string; requester: string; requesterId: number | null; at: number }[])
    .map((one): WorkInput => ({
      key: `job:${one.id}`, chatId: one.chatId, at: one.at, kind: "job",
      words: { kind: "job", title: one.title, instruction: one.instruction, requester: one.requester, requesterId: one.requesterId },
    }));
  const bare = (db.query(`SELECT id, chat_id AS chatId, prompt, launched_at AS at FROM jobs
      WHERE todo_id IS NULL AND chat_id IS NOT NULL AND prompt IS NOT NULL AND trim(prompt) <> '' ORDER BY id`).all() as
      { id: number; chatId: number; prompt: string; at: number }[])
    .map((one): WorkInput => ({ key: `task:${one.id}`, chatId: one.chatId, at: one.at, kind: "job", words: { kind: "search", query: one.prompt.trim() } }));
  const searches = (db.query(`SELECT id, chat_id AS chatId, query, started_at AS at FROM searches
      WHERE kind = 'search' AND chat_id IS NOT NULL AND trim(coalesce(query, '')) <> '' ORDER BY id`).all() as
      { id: number; chatId: number; query: string; at: number }[])
    .map((one): WorkInput => ({ key: `search:${one.id}`, chatId: one.chatId, at: one.at, kind: "search", words: { kind: "search", query: one.query.trim() } }));

  return distinctWorks([...items, ...bare, ...searches]);
}

// One piece of work per room and text, the first standing; newest first.
export function distinctWorks(works: readonly WorkInput[]): WorkInput[] {
  const seen = new Set<string>();

  return works.filter((one) => {
    const text = `${one.chatId}\u0000${requestText(one.words)}`;

    if (seen.has(text)) {
      return false;
    }

    seen.add(text);

    return true;
  }).sort((left, right) => right.at - left.at);
}

// What a piece of work was asked, as one text.
export function requestText(words: WorkWords): string {
  return words.kind === "job" ? `${words.title}\n${words.instruction}`.trim() : words.query;
}

// What the gate is asked for one piece of work.
export function askOf(work: WorkInput): InputsAsk {
  return { chatId: work.chatId, messageIds: [], work: work.words };
}

// One piece the teacher reads: its slug, its index line and its body.
export interface TaughtPiece {
  slug: string;
  line: string;
  body: string;
}

// One piece of work as the teacher is shown it: what kind it is, who asked, its request, and the slugs of
// the pieces its input offers, each answered.
export interface TaughtWork {
  id: string;
  kind: "job" | "search";
  // The requester of an item, as a stand-in; none for a job's own text or a search.
  requester: string | null;
  request: string;
  candidates: string[];
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(cut)`;
}

// The work as the teacher reads it, out of the gate's input for it. Null where the knowledge gate is not asked
// on it, as it is then not asked on the live road either.
export function taughtWork(work: WorkInput, live: LiveTurn, leave: (text: string) => string): TaughtWork | null {
  const gate = live.gates.find((one) => one.gate === distilledGate);

  if (gate === undefined || gate.candidates.length === 0) {
    return null;
  }

  return {
    id: work.key,
    kind: work.kind,
    requester: work.words.kind === "job" ? leave(work.words.requester) : null,
    request: clip(leave(requestText(work.words)), requestLimit),
    candidates: gate.candidates.map((one) => one.slug),
  };
}

// The batches the works are taught in: at most a batch's count each, works of one room together, since
// a batch carries the pieces its works are offered once.
export function teachBatches(works: readonly (TaughtWork & { chatId: number })[], most = worksPerBatch): TaughtWork[][] {
  const byRoom = new Map<number, TaughtWork[]>();

  for (const one of works) {
    const { chatId, ...work } = one;

    byRoom.set(chatId, [...byRoom.get(chatId) ?? [], work]);
  }

  return [...byRoom.values()].flatMap((room) => Array.from({ length: Math.ceil(room.length / most) }, (_, at) => room.slice(at * most, (at + 1) * most)));
}

// What the teacher is told once per call (docs/reference-data.md, 「Distilled work labels」).
export const teacherSystem = [
  "You label training data for the chat agent's knowledge gate.",
  "The chat agent is an assistant that hands out work: a job (an item's title and request, written by whoever asked for it, or a job's own text), or a search (a question). Before a piece of work runs, the knowledge gate picks which pieces of the chat agent's knowledge library are handed to the worker with its prompt. A piece is a fact the chat agent keeps (about its machines, accounts, settings, past results) or a rule every room keeps (how a kind of work must be done).",
  "You are shown the library's pieces — each with its index line and its whole body — and the works, each with the slugs of the pieces the gate is asked about for it. For every work and every one of its candidate slugs, judge from the work's request alone, as the gate must before the work runs, whether the work needs that piece:",
  "- needed: doing this work right rests on something only this piece holds — a fact, number, name, procedure or rule the work must use or follow. A worker handed the work without it would likely get something wrong, do it against a standing rule, or have to go and find it out.",
  "- not-needed: the work is done right without it. A piece whose topic or words merely touch the work's is not-needed unless the work actually depends on what it holds.",
  "For each, also give p, your probability from 0 to 1 that the piece is needed, and why: one short sentence naming what in the request and the piece decides it.",
  "Answer with one JSON array and nothing else. Each element is {\"id\": <the work's id>, \"labels\": {<slug>: {\"word\": \"needed\" | \"not-needed\", \"p\": <number>, \"why\": <sentence>}}}. Answer every work and every candidate slug of it, and no other slug.",
].join("\n");

// One batch's prompt: the pieces its works are offered, then the works.
export function teachPrompt(works: readonly TaughtWork[], pieces: readonly TaughtPiece[]): string {
  const offered = new Set(works.flatMap((one) => one.candidates));

  return [
    "LIBRARY:",
    ...pieces.filter((one) => offered.has(one.slug)).map((one) => JSON.stringify({ slug: one.slug, line: one.line, body: clip(one.body, bodyLimit) })),
    "",
    "WORKS:",
    ...works.map((one) => JSON.stringify(one)),
  ].join("\n");
}

// How many times each work is taught, each time on its own: the gold is the mean of the teacher's samples,
// the way Laya's own benchmark data is made, so it stays soft where the teacher is in two minds.
export const samples = 3;

// One sample of a distilled label: the word, the teacher's probability and its reason, and which of the
// samples it is.
export type DistilledLabel = Label & { p: number; why: string; sample: number };

// The labels one answer gives for one sample. A candidate left unanswered, answered with a word not
// offered, or with no probability is no label, and is asked again on the next run.
export function readTeaching(answer: string, works: readonly TaughtWork[], batch: number, at: string, sample: number): DistilledLabel[] {
  const written = jsonArrayIn(answer) ?? jsonObjectsIn(answer) ?? [];
  const asked = new Map(works.map((one) => [one.id, one]));
  const labels = new Map<string, DistilledLabel>();

  for (const one of written) {
    const said = typeof one === "object" && one !== null ? one as { id?: unknown; labels?: unknown } : {};
    const work = typeof said.id === "string" ? asked.get(said.id) : undefined;

    if (work === undefined || typeof said.labels !== "object" || said.labels === null) {
      continue;
    }

    for (const slug of work.candidates) {
      const given = (said.labels as Record<string, unknown>)[slug];
      const answered = typeof given === "object" && given !== null ? given as { word?: unknown; p?: unknown; why?: unknown } : {};

      if ((answered.word !== "needed" && answered.word !== "not-needed") || typeof answered.p !== "number" || !(answered.p >= 0 && answered.p <= 1)) {
        continue;
      }

      labels.set(labelKey(work.id, distilledGate, slug), {
        turn: work.id, gate: distilledGate, slug, word: answered.word, attached: false, batch, at,
        p: answered.p, why: typeof answered.why === "string" ? answered.why : "", sample,
      });
    }
  }

  return [...labels.values()];
}

// Every sample standing, by label key and sample; a sample given twice keeps its latest.
export function readDistilledLabels(path: string): Map<string, Map<number, DistilledLabel>> {
  const labels = new Map<string, Map<number, DistilledLabel>>();

  for (const line of existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((one) => one.trim() !== "") : []) {
    const one = JSON.parse(line) as DistilledLabel;
    const key = labelKey(one.turn, one.gate, one.slug);

    labels.set(key, (labels.get(key) ?? new Map()).set(one.sample, one));
  }

  return labels;
}

// The labels the rows are made of: a candidate every sample has answered, its probability the samples'
// mean and its word the mean's side of a half.
export function meanLabels(labels: ReadonlyMap<string, ReadonlyMap<number, DistilledLabel>>): Map<string, Label> {
  const meant = new Map<string, Label>();

  for (const [key, given] of labels) {
    if (given.size < samples) {
      continue;
    }

    const all = [...given.values()];
    const p = all.reduce((sum, one) => sum + one.p, 0) / all.length;

    meant.set(key, { ...all[0]!, word: p >= 0.5 ? "needed" : "not-needed", p });
  }

  return meant;
}

// How often one sample's word agrees with the word of the other samples' mean, over the candidates every
// sample answered: the teacher's agreement with itself, the most a student of it can be read to reach.
export function selfAgreement(labels: ReadonlyMap<string, ReadonlyMap<number, DistilledLabel>>): { asked: number; agreed: number } {
  let asked = 0;
  let agreed = 0;

  for (const given of labels.values()) {
    if (given.size < samples) {
      continue;
    }

    for (const one of given.values()) {
      const others = [...given.values()].filter((other) => other.sample !== one.sample);
      const rest = others.reduce((sum, other) => sum + other.p, 0) / others.length;

      asked += 1;
      agreed += (one.word === "needed") === (rest >= 0.5) ? 1 : 0;
    }
  }

  return { asked, agreed };
}

export function appendDistilledLabels(path: string, labels: readonly DistilledLabel[]): void {
  if (labels.length > 0) {
    appendFileSync(path, labels.map((one) => `${JSON.stringify(one)}\n`).join(""));
  }
}

// The samples a work still wants: those some candidate of it has no answer of.
export function wantedSamples(work: TaughtWork, labels: ReadonlyMap<string, ReadonlyMap<number, DistilledLabel>>): number[] {
  return Array.from({ length: samples }, (_, sample) => sample)
    .filter((sample) => work.candidates.some((slug) => !(labels.get(labelKey(work.id, distilledGate, slug))?.has(sample) ?? false)));
}

// The works a run still wants taught: those still wanting a sample.
export function untaught<T extends TaughtWork>(works: readonly T[], labels: ReadonlyMap<string, ReadonlyMap<number, DistilledLabel>>): T[] {
  return works.filter((one) => wantedSamples(one, labels).length > 0);
}

// One split's rows of a training on distilled work labels (docs/reference-data.md, 「Distilled work labels」):
// the reference run's rows, each named for its kind; in training and calibration its work rows replaced by
// the distilled rows of any work taught, and the distilled rows of works it never had added; its test rows
// kept whole, so a checkpoint is measured on what the judge found. One row an id, the distilled first.
export function trainingSplit<T extends { id: string; turn: string; stratum?: string }>(
  split: "train" | "calibration" | "test",
  reference: readonly T[],
  distilled: readonly T[],
  taught: ReadonlySet<string>,
): (T & { stratum: string })[] {
  const named = reference.map((row) => ({ ...row, stratum: row.stratum ?? stratumOf(row.turn.startsWith("job:") || row.turn.startsWith("search:") ? "work" : "record") }));
  const kept = split === "test" ? named : named.filter((row) => row.stratum !== "work" || !taught.has(row.turn));
  const seen = new Set<string>();

  const added = split === "test" ? [] : distilled.map((row) => ({ ...row, stratum: row.stratum ?? stratumOf("work") }));

  return [...added, ...kept].filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}
