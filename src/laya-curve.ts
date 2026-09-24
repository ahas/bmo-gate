import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { growingCounts, mergeGates } from "./gate-merge";
import { printedWidth } from "./laya-nodes";
import { writeGateDataset } from "./laya-train";

import type { DatasetSplit } from "./laya-dataset";
import type { MergedPart } from "./gate-merge";
import type { TrainLedger } from "./laya-train";

// Training while the judging still runs (docs/laya-train-run.md 「Training while the judging runs」).
// A pass cuts every gate at the batches it has frozen so far, trains the gates that have grown
// enough since they were last trained, and writes one point a gate into the curve: how many rows it
// was trained on and what the calibration measured. Read gate by gate, the points are the curve of
// what more data buys.
//
// What a pass trains on is always the gate's own rows in the splits their input hashes fixed, so a
// row measured once is measured in every pass after it and the points stand on one test set that
// only grows.

// The fewest rows a gate is trained on. At the fifteen per cent the run holds out for each of the
// calibration and the test, a thousand rows is about a hundred and fifty test rows: the least on
// which a balanced accuracy moves by less between two passes than it does by chance (one standard
// error is about four points there, and it widens past five below a hundred rows). A gate below it
// would draw a curve out of noise.
export const curveFloor = 1000;

// How much a gate must grow before it is trained again: a quarter more rows than its last point.
// A learning curve moves with the logarithm of the data, so points spaced by a constant ratio are
// spaced evenly along it, and the cost of all the passes a gate ever gets is bounded by a few times
// the cost of its last one rather than growing with how often a pass is run.
export const curveGrowth = 1.25;

export const curveFile = "curve.jsonl";

export interface CurvePoint {
  pass: number;
  at: string;
  // The judging run the rows were cut from, and the training run the pass was on the nodes as.
  run: string;
  training: string;
  gate: string;
  // When the gate's judging began. A gate started over is a series of its own, and a point is only
  // compared with the points of its own series.
  started: string;
  // Whether the judging of the gate had finished when it was cut.
  finished: boolean;
  rows: number;
  train: number;
  calibration: number;
  test: number;
  node: string | null;
  state: "done" | "failed" | "unreachable";
  agreement: number | null;
  balanced: number | null;
  ece: number | null;
  seconds: number | null;
  fault: string | null;
}

export function readCurve(folder: string): CurvePoint[] {
  const path = join(folder, curveFile);

  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
    try {
      return [JSON.parse(line) as CurvePoint];
    } catch {
      return [];
    }
  });
}

// A pass's points go on the end in one write, so a reader never meets half a pass and the points
// already there are never rewritten.
export function appendCurve(folder: string, points: readonly CurvePoint[]): void {
  if (points.length === 0) {
    return;
  }
  mkdirSync(folder, { recursive: true });
  appendFileSync(join(folder, curveFile), points.map((point) => `${JSON.stringify(point)}\n`).join(""));
}

export function nextPass(points: readonly CurvePoint[]): number {
  return points.reduce((most, point) => Math.max(most, point.pass), 0) + 1;
}

export function passName(run: string, pass: number): string {
  return `${run}-p${String(pass).padStart(4, "0")}`;
}

function total(rows: Record<DatasetSplit, number>): number {
  return rows.train + rows.calibration + rows.test;
}

export interface CurveRule {
  floor: number;
  growth: number;
  // The fewest questions of its rarer answer a gate is trained on, or zero to hold it to its rows
  // alone. The row floor reckons with the rarer answer a fifth of the rows; a gate whose rarer answer
  // is a few in a hundred clears it with too little of that answer to learn or to be measured on.
  rarer?: number;
}

export interface PassChoice {
  train: MergedPart[];
  waiting: Array<{ gate: string; rows: number; reason: string }>;
}

// Which gates this pass trains, read from how far each has got and the curve so far. A gate whose
// last point trained is trained again once it has grown by the ratio. One whose last point failed is
// tried once more on the next pass, since most failures are a node's rather than the gate's; after
// two failures on the same rows it waits for a new row, so a gate that cannot be trained is not sent
// to a node on every pass once its judging has stopped.
function rowsWanted(last: CurvePoint, before: CurvePoint | undefined, rule: CurveRule): number {
  if (last.state === "done") {
    return Math.ceil(last.rows * rule.growth);
  }

  return before !== undefined && before.state !== "done" && before.rows === last.rows ? last.rows + 1 : last.rows;
}

export function choosePass(counts: readonly MergedPart[], points: readonly CurvePoint[], rule: CurveRule): PassChoice {
  const choice: PassChoice = { train: [], waiting: [] };

  for (const count of counts) {
    const rows = total(count.rows);
    const empty = (Object.keys(count.rows) as DatasetSplit[]).filter((split) => count.rows[split] === 0);

    if (rows < rule.floor || empty.length > 0) {
      choice.waiting.push({ gate: count.gate, rows, reason: empty.length > 0 && rows >= rule.floor
        ? `${empty.join(", ")} 분할이 비어 있음`
        : `최소 ${rule.floor}행 미달` });
      continue;
    }

    if (count.rarer < (rule.rarer ?? 0)) {
      choice.waiting.push({ gate: count.gate, rows, reason: `드문 답 ${count.rarer}개, 최소 ${rule.rarer}개 미달` });
      continue;
    }

    const series = points.filter((point) => point.gate === count.gate && point.started === count.started);
    const last = series.at(-1);

    if (last === undefined) {
      choice.train.push(count);
      continue;
    }

    const wanted = rowsWanted(last, series.at(-2), rule);

    if (rows >= wanted) {
      choice.train.push(count);
    } else {
      choice.waiting.push({ gate: count.gate, rows, reason: `${last.pass}회차 ${last.rows}행, 다음은 ${wanted}행부터` });
    }
  }

  return choice;
}

export interface PassOptions {
  // The judging run's folder and the name the pass calls it by.
  root: string;
  run: string;
  // Where the curve is kept, and where each pass's training run keeps its dataset and ledger.
  curve: string;
  trainingRoot: (training: string) => string;
  rule: CurveRule;
  // The nodes that are free and ready now. Asked at the start of a pass rather than fixed, since a
  // node busy with somebody else's work is not one to put a gate on.
  nodes: () => Promise<string[]>;
  train: (gates: readonly string[], nodes: readonly string[], training: string, gateFolders: Record<string, string>) => Promise<TrainLedger>;
  now?: () => Date;
  say?: (line: string) => void;
}

export interface PassReport {
  pass: number | null;
  training: string | null;
  choice: PassChoice;
  points: CurvePoint[];
  fault: string | null;
}

// One pass: cut, choose, train, record. Nothing is written when there is nothing to train, so a pass
// run on a timer costs one reading of the batches while the judging has not moved far enough.
export async function runPass(options: PassOptions): Promise<PassReport> {
  const now = options.now ?? (() => new Date());
  const say = options.say ?? (() => {});
  const counts = growingCounts(options.root);

  if (typeof counts === "string") {
    return { pass: null, training: null, choice: { train: [], waiting: [] }, points: [], fault: counts };
  }

  const before = readCurve(options.curve);
  const choice = choosePass(counts, before, options.rule);

  for (const one of choice.waiting) {
    say(`${one.gate}: ${one.rows}행 — ${one.reason}`);
  }
  if (choice.train.length === 0) {
    return { pass: null, training: null, choice, points: [], fault: null };
  }

  const nodes = await options.nodes();

  if (nodes.length === 0) {
    return { pass: null, training: null, choice, points: [], fault: "학습시킬 노드가 하나도 준비되어 있지 않아요." };
  }

  const pass = nextPass(before);
  const training = passName(options.run, pass);
  const folder = options.trainingRoot(training);
  const gates = choice.train.map((one) => one.gate);
  const merged = mergeGates({ root: options.root, into: join(folder, "dataset"), gates, overwrite: true, growing: true });

  if (typeof merged === "string") {
    return { pass, training, choice, points: [], fault: merged };
  }

  const gateFolders: Record<string, string> = {};

  for (const gate of gates) {
    const cut = writeGateDataset(merged.folder, gate, join(folder, "gates", gate));

    if (typeof cut === "string") {
      return { pass, training, choice, points: [], fault: cut };
    }
    gateFolders[gate] = cut.folder;
  }

  say(`${pass}회차 (${training}): ${merged.parts.map((one) => `${one.gate} ${total(one.rows)}행`).join(", ")} — ${nodes.join(", ")}`);

  const ledger = await options.train(gates, nodes, training, gateFolders);
  const at = now().toISOString();
  const points = merged.parts.map((part): CurvePoint => {
    const row = ledger.rows.find((one) => one.gate === part.gate);

    return {
      pass, at, run: options.run, training, gate: part.gate, started: part.started, finished: part.finished,
      rows: total(part.rows), train: part.rows.train, calibration: part.rows.calibration, test: part.rows.test,
      node: row?.node ?? null,
      state: row?.state ?? "failed",
      agreement: row?.calibration?.agreement ?? null,
      balanced: row?.calibration?.balanced ?? null,
      ece: row?.calibration?.ece ?? null,
      seconds: row?.seconds ?? null,
      fault: row === undefined ? "학습 원장에 이 게이트의 줄이 없어요." : row.fault,
    };
  });

  appendCurve(options.curve, points);

  return { pass, training, choice, points, fault: null };
}

const figure = (value: number | null): string => value === null ? "—" : value.toFixed(4);

// The curve as a sheet, a block a gate, its points in the order they were trained: the rows it was
// trained on against the three figures. A point that failed keeps its line and says why.
export function curveLines(points: readonly CurvePoint[]): string[] {
  const gates = [...new Set(points.map((point) => point.gate))].sort();
  const head = ["게이트", "회차", "행", "학습", "시험", "일치도", "균형", "보정오차", "노드", "상태"];
  const body = gates.flatMap((gate) => points.filter((point) => point.gate === gate).map((point) => [
    gate,
    String(point.pass),
    `${point.rows}${point.finished ? " (판정 끝)" : ""}`,
    String(point.train),
    String(point.test),
    figure(point.agreement),
    figure(point.balanced),
    figure(point.ece),
    point.node ?? "—",
    point.state === "done" ? "끝남" : point.state === "unreachable" ? "닿지 않음" : "실패",
  ]));
  const widths = head.map((_, column) => Math.max(...[head, ...body].map((line) => printedWidth(line[column] ?? ""))));
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column]! - printedWidth(cell)))).join("  ").trimEnd();
  const notes = points.filter((point) => point.fault !== null).map((point) => `${point.pass}회차 ${point.gate}: ${point.fault}`);

  return [line(head), line(widths.map((width) => "-".repeat(width))), ...body.map(line), ...notes.length > 0 ? ["", ...notes] : []];
}
