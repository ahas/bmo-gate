import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { datasetSplits } from "./laya-dataset";
import { splitFiles } from "./laya-frozen";
import { answersOf, datasetRowOf, gateSyntheses, languageOf, stateText, synthesisFor, transcriptLineShape, validateSynthRow } from "./laya-synth";
import { languageFile } from "./laya-synth-run";
import { promptFile } from "./prompts";

import type { LayaQuestion, LayaState } from "./laya";
import type { DatasetRow, DatasetSplit, Gold, SplitShares } from "./laya-dataset";
import type { GateSynthesis, SynthRow } from "./laya-synth";

// A rehearsal dataset: every gate's three splits, written by this machine alone with no model
// asked and no conversation read (docs/training.md, 「Rehearsal」). It exists so the
// resume, the driver, the collection and the tables can be put through their paces whole before the
// distilled data is paid for, and it is marked at every level so a figure measured on it can never be
// read as a gate's.
//
// Every row is built out of its gate's own worked example — the one the specification states and the
// synthesis module's tests hold to the validator — and varied. Nothing is written that the validator
// would refuse, so what a rehearsal row exercises is the shape a real row will have.

/** The field every rehearsal row carries. The training scripts read the state, the questions and the
 * gold and pass over what they do not know, so the mark rides along without changing what is
 * trained. */
export const REHEARSAL_FIELD = "rehearsal";

/** What a rehearsal folder says about itself, beside the marked rows. */
export const rehearsalMetaFile = "rehearsal.meta.json";

export const REHEARSAL_KIND = "laya-rehearsal";

export interface RehearsalRow extends DatasetRow {
  rehearsal: true;
}

export interface RehearsalMeta {
  kind: typeof REHEARSAL_KIND;
  written: string;
  seed: number;
  rowsAsked: number;
  shares: SplitShares;
  gates: Array<{ gate: string; rows: number; splits: Record<DatasetSplit, number>; answers: Record<string, number> }>;
}

/** What a run is called where a figure of it is shown. Every line of every table carries it, so a
 * line read on its own still says whether what stands beside it is a gate's or a rehearsal's. */
export const REHEARSAL_WORD = "rehearsal";
export const REAL_WORD = "real";

export function runWord(rehearsal: boolean): string {
  return rehearsal ? REHEARSAL_WORD : REAL_WORD;
}

export function isRehearsalRow(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)[REHEARSAL_FIELD] === true;
}

/** What a folder says it is, or null where it says nothing. Read before a number out of it is
 * reported, since a rehearsal figure is never evidence. */
export function rehearsalMeta(folder: string): RehearsalMeta | null {
  const path = join(folder, rehearsalMetaFile);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const read: unknown = JSON.parse(readFileSync(path, "utf8"));

    return typeof read === "object" && read !== null && (read as RehearsalMeta).kind === REHEARSAL_KIND ? read as RehearsalMeta : null;
  } catch {
    return null;
  }
}

/** Whether a dataset folder is a rehearsal one. The meta file is the plain answer; a folder carrying
 * marked rows and no meta is one too, since the mark travels with the rows wherever they are copied
 * and the file does not. */
export function rehearsalFolder(folder: string): boolean {
  if (rehearsalMeta(folder) !== null) {
    return true;
  }

  for (const name of Object.values(splitFiles)) {
    const path = join(folder, name);

    if (!existsSync(path)) {
      continue;
    }

    const first = readFileSync(path, "utf8").split("\n").find((line) => line.trim() !== "");

    if (first !== undefined) {
      try {
        return isRehearsalRow(JSON.parse(first));
      } catch {
        return false;
      }
    }
  }

  return false;
}

// One seeded stream of numbers, so the same seed writes the same dataset on any machine and a
// different seed writes another one. It is the small well-known mulberry32, which is all a fixture
// needs and is short enough to read.
function numbersFrom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let drawn = state;
    drawn = Math.imul(drawn ^ (drawn >>> 15), drawn | 1);
    drawn ^= drawn + Math.imul(drawn ^ (drawn >>> 7), drawn | 61);

    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedOf(seed: number, gate: string): number {
  return [...gate].reduce((held, letter) => (Math.imul(held, 31) + letter.codePointAt(0)!) >>> 0, seed >>> 0);
}

// What a varied line says, out of `prompts/tooling/rehearsal.toml`. They are in the rooms' language because
// every gate's example is, and a row's language is read off what a person would read: a line of English in a
// Korean row would make the row mixed and the validator would refuse it.
function sentences(): readonly string[] {
  const said = promptFile("rehearsal").sentences;

  if (!Array.isArray(said) || said.length === 0 || !said.every((one) => typeof one === "string" && one !== "")) {
    throw new Error("sentences in prompts/tooling/rehearsal.toml is not a list of lines");
  }

  return said as string[];
}

function sentence(pick: () => number, index: number): string {
  const said = sentences();

  return `${said[Math.floor(pick() * said.length)]!} (${index})`;
}

/** One transcript line with its body swapped and its prefix — the name, the number, the time — kept
 * exactly as it stood, since that prefix is the shape the gate's own reader matches. */
function variedLine(gate: GateSynthesis, line: string, pick: () => number, index: number): string {
  const marker = transcriptLineShape(gate.transcript!.shape).exec(line);

  return marker === null ? sentence(pick, index) : `${marker[0]}${sentence(pick, index)}`;
}

function variedLines(gate: GateSynthesis, value: unknown, pick: () => number, index: number): unknown {
  if (typeof value === "string") {
    return value.split("\n").map((line) => variedLine(gate, line, pick, index)).join("\n");
  }

  if (Array.isArray(value)) {
    return value.map((line) => typeof line === "string" ? variedLine(gate, line, pick, index) : line);
  }

  return value;
}

function variedText(value: unknown, pick: () => number, index: number): unknown {
  if (typeof value === "string") {
    return value.split("\n").map(() => sentence(pick, index)).join("\n");
  }

  if (Array.isArray(value)) {
    return value.map((line) => typeof line === "string" ? sentence(pick, index) : line);
  }

  return value;
}

/** The example's state with everything a person would read swapped for other words, and everything
 * the gate reads as machinery — the kind of room, who wrote the note — cycled through the values the
 * gate declares. What is neither is left as the example has it. */
export function variedState(gate: GateSynthesis, pick: () => number, index: number): LayaState {
  const example = gate.example.state;

  if (typeof example === "string") {
    return gate.transcript !== null
      ? example.split("\n").map((line) => variedLine(gate, line, pick, index)).join("\n")
      : example.split("\n").map(() => sentence(pick, index)).join("\n");
  }

  if (typeof example !== "object" || example === null || Array.isArray(example)) {
    return example;
  }

  const transcripts = new Set(gate.transcript?.fields ?? []);
  const held: Record<string, unknown> = { ...example as Record<string, unknown> };

  for (const [field, allowed] of Object.entries(gate.choices ?? {})) {
    held[field] = allowed[index % allowed.length]!;
  }
  for (const field of gate.textFields) {
    held[field] = transcripts.has(field)
      ? variedLines(gate, held[field], pick, index)
      : variedText(held[field], pick, index);
  }

  return held;
}

/** One question's gold for this row: an answer chosen in turn, so every answer of every question is
 * taught and no gate's rehearsal data is all one answer. */
export function variedGold(question: LayaQuestion, answers: readonly string[], turn: number): Gold {
  const chosen = answers[turn % answers.length]!;

  if (question.type === "noul") {
    const trueWeight = chosen === "true" ? 0.9 : 0.1;

    return { type: "noul", label: chosen as "true" | "false", noul: trueWeight, probabilities: { true: trueWeight, false: rounded(1 - trueWeight) } };
  }

  const rest = rounded((1 - 0.7) / Math.max(1, answers.length - 1));
  const probabilities = Object.fromEntries(answers.map((answer) => [answer, answer === chosen ? rounded(1 - rest * (answers.length - 1)) : rest]));

  return { type: "choice", label: chosen, probabilities };
}

// Probabilities are written as a reader would write them rather than as the division leaves them: a
// gold of 0.09999999999999998 is the same number and is not what anybody means.
function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export interface RehearsalFault {
  gate: string;
  index: number;
  refusal: string;
  detail: string;
}

/** `count` rows of one gate, built from its own worked example. The same gate, count and seed give
 * the same rows every time, which is what lets a rehearsal run be repeated exactly. */
export function rehearsalRows(gate: GateSynthesis, count: number, seed: number): SynthRow[] {
  const pick = numbersFrom(seedOf(seed, gate.gate));
  const rows: SynthRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const questions = gate.example.questions;
    const gold: Record<string, Gold> = {};
    let turn = index;

    for (const [id, question] of Object.entries(questions)) {
      const declared = gate.questions.find((one) => id === one.id || id.endsWith(`:${one.id}`)) ?? gate.questions[0]!;

      gold[id] = variedGold(question, answersOf(declared), turn);
      turn += 1;
    }

    rows.push({ state: variedState(gate, pick, index), questions: { ...questions }, gold });
  }

  return rows;
}

/** Every row of every gate, checked against the gate it belongs to. A fault here is a fixture that
 * would teach a shape the real pipeline refuses, so it stops the writing rather than being counted. */
export function rehearsalFaults(gates: readonly GateSynthesis[], count: number, seed: number): RehearsalFault[] {
  const faults: RehearsalFault[] = [];

  for (const gate of gates) {
    rehearsalRows(gate, count, seed).forEach((row, index) => {
      const verdict = validateSynthRow(gate, row, "korean");

      if (!verdict.ok) {
        faults.push({ gate: gate.gate, index, refusal: verdict.refusal, detail: verdict.detail });
      }
    });
  }

  return faults;
}

export interface RehearsalBuild {
  folder: string;
  gates?: readonly string[];
  rows?: number;
  seed?: number;
  shares?: SplitShares;
  /** How many rows of each gate each split must hold before the gate is done. A split with nothing in
   * it is a calibration or a measurement that cannot run at all. */
  minPerSplit?: number;
}

export const rehearsalShares: SplitShares = { calibration: 0.2, test: 0.2 };

export function rehearsalGates(names: readonly string[] | undefined): GateSynthesis[] | string {
  if (names === undefined || names.length === 0) {
    return [...gateSyntheses()];
  }
  const chosen: GateSynthesis[] = [];

  for (const name of names) {
    const gate = synthesisFor(name);

    if (gate === null) {
      return name;
    }
    chosen.push(gate);
  }

  return chosen;
}

/** The rows of one gate, gone on with until every split holds what it owes. The split is the row's
 * own hash, so the only way to fill a thin split is to write more rows; the bound is what keeps a
 * gate that cannot fill one from going round for ever. */
export function rowsUntilSplitsFill(
  gate: GateSynthesis, wanted: number, minPerSplit: number, seed: number, shares: SplitShares,
): { rows: SynthRow[]; splits: Record<DatasetSplit, number> } | string {
  const bound = Math.max(wanted * 20, wanted + 200);

  for (let count = wanted; count <= bound; count += Math.max(1, Math.round(wanted / 4))) {
    const rows = rehearsalRows(gate, count, seed);
    const splits = { train: 0, calibration: 0, test: 0 };

    for (const row of rows) {
      splits[datasetRowOf(gate, row, shares).split] += 1;
    }
    if (datasetSplits.every((split) => splits[split] >= minPerSplit)) {
      return { rows, splits };
    }
  }

  return `${gate.gate}: even at ${bound} rows, the three splits did not each fill ${minPerSplit} rows`;
}

/** The folder written: the three splits, the language beside each row, and the meta that says what
 * this is. It returns what it wrote, or the fault that stopped it before anything was written. */
export function buildRehearsal(build: RehearsalBuild): RehearsalMeta | string {
  const gates = rehearsalGates(build.gates);

  if (typeof gates === "string") {
    return `${gates}: no such gate. Choose among: ${gateSyntheses().map((one) => one.gate).join(", ")}`;
  }

  const rows = build.rows ?? 60;
  const seed = build.seed ?? 713;
  const shares = build.shares ?? rehearsalShares;
  const minPerSplit = build.minPerSplit ?? 2;
  const faults = rehearsalFaults(gates, rows, seed);

  if (faults.length > 0) {
    const said = faults.slice(0, 5).map((one) => `${one.gate}[${one.index}] ${one.refusal}: ${one.detail}`);

    return [`Rehearsal rows did not keep their gate's specification (${faults.length}):`, ...said].join("\n");
  }

  const written: RehearsalRow[] = [];
  const languages: string[] = [];
  const figures: RehearsalMeta["gates"] = [];

  for (const gate of gates) {
    const filled = rowsUntilSplitsFill(gate, rows, minPerSplit, seed, shares);

    if (typeof filled === "string") {
      return filled;
    }

    const answers: Record<string, number> = {};

    for (const row of filled.rows) {
      const made = datasetRowOf(gate, row, shares);

      written.push({ ...made, [REHEARSAL_FIELD]: true } as RehearsalRow);
      languages.push(JSON.stringify({ id: made.id, language: languageOf(stateText(gate, row.state)) }));

      for (const gold of Object.values(row.gold)) {
        answers[gold.label] = (answers[gold.label] ?? 0) + 1;
      }
    }

    figures.push({ gate: gate.gate, rows: filled.rows.length, splits: filled.splits, answers });
  }

  mkdirSync(build.folder, { recursive: true });

  for (const [split, name] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
    const lines = written.filter((row) => row.split === split).map((row) => JSON.stringify(row));

    writeFileSync(join(build.folder, name), lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  }
  writeFileSync(join(build.folder, languageFile), languages.length === 0 ? "" : `${languages.join("\n")}\n`);

  const meta: RehearsalMeta = {
    kind: REHEARSAL_KIND,
    written: new Date().toISOString(),
    seed,
    rowsAsked: rows,
    shares,
    gates: figures,
  };

  writeFileSync(join(build.folder, rehearsalMetaFile), `${JSON.stringify(meta, null, 2)}\n`);

  return meta;
}

/** What was written, said in the words a person reads. */
export function rehearsalLines(meta: RehearsalMeta): string[] {
  const lines = [
    `Rehearsal data: ${meta.gates.length} gates · seed ${meta.seed} · from ${meta.rowsAsked} rows a gate`,
    `${"gate".padEnd(22)}${"rows".padStart(4)}${"train".padStart(6)}${"cal".padStart(5)}${"test".padStart(5)}  answers`,
  ];

  for (const gate of meta.gates) {
    const answers = Object.entries(gate.answers).sort().map(([answer, count]) => `${answer} ${count}`).join(", ");

    lines.push([
      gate.gate.padEnd(22),
      String(gate.rows).padStart(4),
      String(gate.splits.train).padStart(6),
      String(gate.splits.calibration).padStart(5),
      String(gate.splits.test).padStart(5),
      `  ${answers}`,
    ].join(""));
  }

  lines.push("A figure measured on this data says only whether the machinery runs, never whether a gate is any good.");

  return lines;
}
