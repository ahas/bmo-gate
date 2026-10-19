import { answersOf, synthesisFor, validateSynthRow, languageOf, stateText, datasetRowOf } from "./laya-synth";
import { jsonArrayIn, jsonObjectsIn } from "./laya-teach";
import { filled, promptFile, promptText } from "./prompts";

import type { GateSynthesis, SynthRefusal, SynthRow } from "./laya-synth";
import type { DatasetRow, Gold, SplitShares } from "./laya-dataset";
import type { LayaQuestion } from "./laya";
import type { UnjudgedRow } from "./real-rows";

// The judgement of rows built out of real conversation (docs/gate-data.md, 「Judging the real
// rows」). The rows come in with no answer on them; what goes out is the same row with a gold.
//
// The gate's own questions ride on each row exactly as the gate asks them, so nothing here restates
// a gate's wording: the model is shown the state, the questions as they stand and the answers each
// question may be given, and answers with a probability over those answers rather than one word.
// A gold that is a distribution is what the training loop already reads, and it carries the
// judge's doubt as well as its verdict.

// The system prompt, which says nothing about any one gate or any one row, so the prefix a road
// caches is the same on every batch of every gate. Its words stand in `prompts/tooling/gate-judge.toml`.
export function judgeSystem(): string {
  const lines = promptFile("gate-judge").system;

  if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
    throw new Error("system in prompts/tooling/gate-judge.toml is not a list of lines");
  }

  return lines.join("\n");
}

export interface JudgeItem {
  id: string;
  state: unknown;
  questions: Record<string, LayaQuestion>;
}

// The judge reads the whole where the row keeps one beside the reduction the gate is shown.
export function judgeItemOf(row: UnjudgedRow): JudgeItem {
  return { id: row.id, state: row.teacher ?? row.state, questions: row.questions };
}

// How many answers one batch may ask for at once. A batch is counted in answers rather than in
// rows because what the judge has to write is one answer a question, and a gate that asks eighty
// questions of a row asks eighty times what a gate asking one does. Twenty rows of the person book
// is sixteen hundred answers in one reply, and codex hands back every row's gold empty rather than
// writing them — which costs the batch whole and reads, from outside, as a gate that judges
// nothing at all.
export const answersPerBatch = 100;

// The batches one gate's rows are judged in, in order. A batch takes rows while it stays under both
// bounds, and always takes one row however many answers that row alone asks for: a row past the cap
// on its own is still a row, and a plan that skipped it would leave a hole nothing can fill.
export function judgeBatches(rows: readonly UnjudgedRow[], batchSize: number, answerCap: number): UnjudgedRow[][] {
  const size = Math.max(1, batchSize);
  const cap = Math.max(1, answerCap);
  const plan: UnjudgedRow[][] = [];
  let taking: UnjudgedRow[] = [];
  let answers = 0;

  for (const row of rows) {
    const asks = Object.keys(row.questions).length;

    if (taking.length > 0 && (taking.length >= size || answers + asks > cap)) {
      plan.push(taking);
      taking = [];
      answers = 0;
    }

    taking.push(row);
    answers += asks;
  }

  if (taking.length > 0) {
    plan.push(taking);
  }

  return plan;
}

// What one batch asks. The gate's line about what it decides stands at the top, then every item
// whole, then the answers each question may take — a judge left to guess the answers of a yes/no
// writes "yes" and "no" and the batch cannot be read back at all.
export function judgePrompt(gate: GateSynthesis, items: readonly JudgeItem[]): string {
  const answers = gate.questions.map((question) => `- ${question.id}: ${answersOf(question).join(", ")}`);

  return [
    filled(promptText("gate-judge", "batch", "gate"), { gate: gate.gate, title: gate.title, judges: gate.judges }),
    "",
    promptText("gate-judge", "batch", "answers"),
    ...answers,
    "",
    promptText("gate-judge", "batch", "items"),
    ...items.map((item) => JSON.stringify(item)),
  ].join("\n");
}

export interface JudgeReading {
  golds: Map<string, Record<string, Gold>>;
  // Items the answer said nothing readable about, counted rather than guessed at.
  refused: number;
}

// The answers read back. A batch whose list came back broken is read one object at a time, because
// the objects are what was asked for and the brackets between them are punctuation.
export function readJudgements(answer: string, items: readonly JudgeItem[]): JudgeReading {
  const written = jsonArrayIn(answer) ?? jsonObjectsIn(answer) ?? [];
  const asked = new Map(items.map((item) => [item.id, item]));
  const golds = new Map<string, Record<string, Gold>>();

  for (const one of written) {
    if (typeof one !== "object" || one === null) {
      continue;
    }

    const said = one as { id?: unknown; gold?: unknown };
    const item = typeof said.id === "string" ? asked.get(said.id) : undefined;

    if (item === undefined || typeof said.gold !== "object" || said.gold === null) {
      continue;
    }

    const gold = goldOf(item.questions, said.gold as Record<string, unknown>);

    if (gold !== null) {
      golds.set(item.id, gold);
    }
  }

  return { golds, refused: items.length - golds.size };
}

// One item's gold, or null where any question of it was left unanswered or answered with something
// that is not one of its answers. A half-answered item is refused whole: a row trained on with one
// question's gold missing teaches that question nothing and weights the rest twice.
function goldOf(questions: Record<string, LayaQuestion>, said: Record<string, unknown>): Record<string, Gold> | null {
  const gold: Record<string, Gold> = {};

  for (const [id, question] of Object.entries(questions)) {
    const one = said[id];

    if (typeof one !== "object" || one === null) {
      return null;
    }

    const probabilities = (one as { probabilities?: unknown }).probabilities;

    if (typeof probabilities !== "object" || probabilities === null) {
      return null;
    }

    const made = goldFrom(question, probabilities as Record<string, unknown>);

    if (made === null) {
      return null;
    }

    gold[id] = made;
  }

  return gold;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

function goldFrom(question: LayaQuestion, probabilities: Record<string, unknown>): Gold | null {
  const options = question.type === "noul"
    ? ["true", "false"]
    : "criteria" in question ? (Array.isArray(question.criteria) ? [...question.criteria] : Object.keys(question.criteria)) : [];

  if (options.length === 0) {
    return null;
  }

  const given: Record<string, number> = {};
  let total = 0;

  for (const option of options) {
    const value = probabilities[option];

    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return null;
    }

    given[option] = value;
    total += value;
  }

  if (total <= 0) {
    return null;
  }

  const shares = Object.fromEntries(options.map((option) => [option, round(given[option]! / total)]));
  const label = options.reduce((best, option) => shares[option]! > shares[best]! ? option : best, options[0]!);

  if (question.type === "noul") {
    const yes = shares.true!;

    return { type: "noul", label: yes >= 0.5 ? "true" : "false", noul: yes, probabilities: { true: yes, false: round(1 - yes) } };
  }

  return { type: "choice", label, probabilities: shares };
}

export interface JudgedRow {
  row: DatasetRow;
  // Where the material came from, which is what keeps a written row out of the figures.
  source: string;
}

export interface JudgeOutcome {
  rows: JudgedRow[];
  // Rows the judge answered but that do not answer their own gate, by the reason each was refused.
  refusals: Record<string, number>;
  unanswered: number;
}

// The rows a batch's answer leaves standing: every item the judge answered, checked against its own
// gate's specification and frozen with the gold on it. A row is refused, never fatal — a gold the
// judge left half-written costs that row and not the batch.
export function judgedRows(
  gate: GateSynthesis,
  items: readonly UnjudgedRow[],
  reading: JudgeReading,
  shares: SplitShares,
  source: string,
): JudgeOutcome {
  const rows: JudgedRow[] = [];
  const refusals: Record<string, number> = {};

  for (const item of items) {
    const gold = reading.golds.get(item.id);

    if (gold === undefined) {
      continue;
    }

    const row: SynthRow = { state: item.state, questions: item.questions, gold };
    // A real row's language is a fact about the room that spoke, not a share it was drawn to, so
    // the language it is held to is its own. The share a gate is drawn to is a reading of the
    // finished data and is made by the audit, not by refusing a room for speaking its own language.
    const verdict = validateSynthRow(gate, row, languageOf(stateText(gate, item.state)));

    if (!verdict.ok) {
      refusals[verdict.refusal] = (refusals[verdict.refusal] ?? 0) + 1;
      continue;
    }

    rows.push({ row: datasetRowOf(gate, row, shares), source });
  }

  return { rows, refusals, unanswered: reading.refused };
}

export function gateFor(gate: string): GateSynthesis {
  const spec = synthesisFor(gate);

  if (spec === null) {
    throw new Error(`${gate} is not a gate this tooling knows.`);
  }

  return spec;
}

export type JudgeRefusal = SynthRefusal;

// The road a batch of judgements rides. It is the asker's shape less the batch plan: a judgement
// is a system prompt, a prompt and the thread the last batch left behind, and every road answers
// it the same way whatever else differs between them.
export type JudgeRoad = (system: string, prompt: string, resumeSessionId: string | null) => Promise<JudgeAnswer>;

export interface JudgeAnswer {
  text: string;
  sessionId: string | null;
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}
