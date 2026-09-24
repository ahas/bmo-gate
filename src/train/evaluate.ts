import { runWord } from "../laya-rehearsal";
import { ledgerLines } from "./ledger";
import { laidOut } from "./table";

import type { Ledger, LedgerRow } from "./ledger";

// The tables a pass is judged on (docs/training.md, 「The tables」), assembled from the pass's ledger
// alone — the calibration's report rides in it — so a table is made from what the pass recorded and
// never from a second reading that could have moved. Every line of a table built on rehearsal data
// says so.

/** The threshold the per-gate table shows missed calls at; the whole ladder stands underneath. */
export const TABLE_TAU = 0.9;

// What one checkpoint came to on the test rows.
export interface Measured {
  agreement: number | null;
  balanced: number | null;
  // The share of the questions whose gold is yes that it answered yes.
  yes: number | null;
  ece: number | null;
}

export interface GateTableRow {
  gate: string;
  node: string;
  rehearsal: boolean;
  questions: number | null;
  // The checkpoint measured beside it: the one serving the gate, or null for the one it came from.
  beside: string | null;
  before: Measured | null;
  after: Measured | null;
  missed: number | null;
  missedTau: number | null;
  fault: string | null;
}

export interface MissedTableRow {
  gate: string;
  rehearsal: boolean;
  question: string;
  settles: string;
  questions: number;
  wanted: number;
  thresholds: { tau: number; settled: number; coverage: number | null; missed: number; missedRate: number | null }[];
}

const numberOr = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const held = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

function gateReport(row: LedgerRow): Record<string, unknown> | null {
  return held(held(held(row.report)?.gates)?.[row.gate]);
}

// One set of figures out of the calibration's report, with the yes answers given back counted off its
// per-answer tallies.
export function measuredOf(figures: Record<string, unknown> | null): Measured | null {
  if (figures === null) {
    return null;
  }

  const wanted = numberOr(held(figures.answers)?.true);
  const given = numberOr(held(figures.correct)?.true);

  return {
    agreement: numberOr(figures.agreement),
    balanced: numberOr(figures.balanced),
    yes: wanted === null || wanted === 0 || given === null ? null : Math.round((given / wanted) * 10_000) / 10_000,
    ece: numberOr(figures.ece),
  };
}

function missedAt(figures: Record<string, unknown> | null, tau: number): number | null {
  const asymmetric = figures?.asymmetric;

  if (!Array.isArray(asymmetric) || asymmetric.length === 0) {
    return null;
  }

  const thresholds = held(asymmetric[0])?.thresholds;
  const at = Array.isArray(thresholds) ? thresholds.map(held).find((one) => one !== null && numberOr(one.tau) === tau) : undefined;

  return at === undefined || at === null ? null : numberOr(at.missed);
}

/** One line a gate. A gate whose run left no report keeps its line and says what stopped it. */
export function gateTableRows(ledger: Ledger, tau: number = TABLE_TAU): GateTableRow[] {
  return ledger.rows.map((row) => {
    const figures = gateReport(row);
    const missed = missedAt(figures, tau);

    return {
      gate: row.gate,
      node: row.node,
      rehearsal: row.rehearsal,
      questions: numberOr(figures?.questions),
      beside: row.beside,
      before: measuredOf(held(figures?.base)),
      after: measuredOf(figures),
      missed,
      missedTau: missed === null ? null : tau,
      fault: figures === null
        ? row.fault ?? (row.state === "done" ? "이 실행은 보정 보고를 남기지 않았어요." : `학습이 ${row.state === "unreachable" ? "노드에 닿지 못해" : "끝나지"} 못했어요.`)
        : row.fault,
    };
  });
}

/** The asymmetric gates' own count, threshold by threshold. A missed call is not an accuracy. */
export function missedTableRows(ledger: Ledger): MissedTableRow[] {
  return ledger.rows.flatMap((row) => {
    const asymmetric = gateReport(row)?.asymmetric;

    return !Array.isArray(asymmetric) ? [] : asymmetric.map(held).flatMap((one) => one === null || !Array.isArray(one.thresholds) ? [] : [{
      gate: row.gate,
      rehearsal: row.rehearsal,
      question: String(one.question ?? ""),
      settles: String(one.settles ?? ""),
      questions: numberOr(one.questions) ?? 0,
      wanted: numberOr(one.wanted) ?? 0,
      thresholds: one.thresholds.map(held).flatMap((at) => at === null ? [] : [{
        tau: numberOr(at.tau) ?? 0,
        settled: numberOr(at.settled) ?? 0,
        coverage: numberOr(at.coverage),
        missed: numberOr(at.missed) ?? 0,
        missedRate: numberOr(at.missed_rate),
      }]),
    }]);
  });
}

const shown = (value: number | null | undefined, places = 3): string => value === null || value === undefined ? "—" : value.toFixed(places);
const moved = (after: number | null | undefined, before: number | null | undefined, places = 3): string => {
  if (after === null || after === undefined || before === null || before === undefined) {
    return "—";
  }

  const value = Math.round((after - before) * 10 ** places) / 10 ** places;

  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(places)}`;
};

/** The before-and-after table. Its first column is what the run was, so a line read on its own still
 * says whether the figures beside it are a gate's or a rehearsal's. */
export function gateTableLines(rows: readonly GateTableRow[], tau: number = TABLE_TAU): string[] {
  if (rows.length === 0) {
    return ["게이트 표에 넣을 것이 없어요."];
  }

  const head = ["실험", "게이트", "문항", "견준 것", "정확도 전→후", "균형 전→후", "균형 차이", "예 재현 전→후", "예 차이", "ECE 전→후", `놓친 호출(τ${tau})`];
  const body = rows.map((row) => [
    runWord(row.rehearsal), row.gate,
    row.questions === null ? "—" : String(row.questions),
    row.beside === null ? "학습 출발점" : row.beside,
    `${shown(row.before?.agreement)}→${shown(row.after?.agreement)}`,
    `${shown(row.before?.balanced)}→${shown(row.after?.balanced)}`,
    moved(row.after?.balanced, row.before?.balanced),
    `${shown(row.before?.yes)}→${shown(row.after?.yes)}`,
    moved(row.after?.yes, row.before?.yes),
    `${shown(row.before?.ece)}→${shown(row.after?.ece)}`,
    row.missed === null ? "—" : String(row.missed),
  ]);
  const notes = rows.filter((row) => row.fault !== null).map((row) => `${row.gate}: ${row.fault}`);

  return [...laidOut(head, body), ...notes.length > 0 ? ["", ...notes] : []];
}

export function missedTableLines(rows: readonly MissedTableRow[]): string[] {
  if (rows.length === 0) {
    return ["비대칭 게이트가 이 회차에는 없어요."];
  }

  const head = ["실험", "게이트", "질문", "Laya가 맡는 답", "τ", "맡은 수", "덮음", "놓친 호출", "놓친 비율"];
  const body = rows.flatMap((row) => row.thresholds.map((at) => [
    runWord(row.rehearsal), row.gate, row.question, row.settles,
    at.tau.toFixed(2), String(at.settled), shown(at.coverage), String(at.missed), shown(at.missedRate),
  ]));
  const said = rows.map((row) => `${row.gate}: 시험 문항 ${row.questions}개 가운데 답이 필요한 것 ${row.wanted}개. `
    + `놓친 호출은 답이 필요한데 Laya가 「${row.settles}」로 맡아 버린 것이에요.`);

  return [...laidOut(head, body), "", ...said];
}

/** Every table as one sheet, with the line that says what these figures are worth. */
export function passTables(ledger: Ledger, tau: number = TABLE_TAU): string[] {
  const rows = gateTableRows(ledger, tau);

  return [
    `# ${ledger.pass} 검증 표`,
    "",
    ...ledger.rehearsal
      ? ["**리허설 데이터로 학습한 회차예요.** 여기 수치는 기계가 제대로 실행되는지만 말하고, 게이트가 쓸 만한지는 말하지 않아요.", ""]
      : [],
    "## 전과 후",
    "",
    ...gateTableLines(rows, tau),
    "",
    "## 비대칭 게이트의 놓친 호출",
    "",
    ...missedTableLines(missedTableRows(ledger)),
    "",
    "## 노드별",
    "",
    ...ledgerLines(ledger),
  ];
}

export function tablesJson(ledger: Ledger, tau: number = TABLE_TAU): Record<string, unknown> {
  return {
    pass: ledger.pass,
    source: ledger.source,
    rehearsal: ledger.rehearsal,
    tau,
    gates: gateTableRows(ledger, tau),
    missed: missedTableRows(ledger),
    nodes: ledger.rows.map((row) => ({
      gate: row.gate, node: row.node, round: row.round, state: row.state, steps: row.steps, resumes: row.resumes,
      seconds: row.seconds, peakReservedBytes: row.peakReservedBytes, microBatch: row.microBatch, accumulate: row.accumulate,
      effectiveBatch: row.effectiveBatch, precision: row.precision, device: row.device,
    })),
  };
}
