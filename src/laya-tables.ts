import { printedWidth } from "./laya-nodes";
import { REAL_WORD, REHEARSAL_WORD, runWord } from "./laya-rehearsal";
import { trainLedgerLines } from "./laya-train";

import type { TrainLedger, TrainLedgerRow } from "./laya-train";

// The two tables the run is judged on (docs/laya-train-run.md, 「The two tables」): the per-gate one
// that says whether a gate's trained model is worth putting in service, and the per-node one
// that says what each run cost. Both are assembled from the ledger alone — the calibration's own
// report rides in it — so a table is made from what the run recorded and never from a second reading
// that could have moved.
//
// Every line of a table built on rehearsal data says so. A rehearsal figure says the machinery works
// and nothing about a gate, and a line lifted out of its table must not read as evidence.

/** The threshold the per-gate table shows missed calls at. The asymmetric gate is made safe by a τ
 * set high, so that is where a reader wants the count; the whole ladder stands underneath. */
export const TABLE_TAU = 0.9;

export { REAL_WORD, REHEARSAL_WORD };

export interface GateTableRow {
  gate: string;
  node: string;
  rehearsal: boolean;
  questions: number | null;
  agreement: number | null;
  balanced: number | null;
  ece: number | null;
  baseAgreement: number | null;
  baseBalanced: number | null;
  baseEce: number | null;
  agreementMoved: number | null;
  balancedMoved: number | null;
  eceMoved: number | null;
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
  thresholds: Array<{ tau: number; settled: number; coverage: number | null; missed: number; missedRate: number | null }>;
}

const numberOr = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const held = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

function gateFigures(row: TrainLedgerRow): Record<string, unknown> | null {
  const gates = held(held(row.report)?.gates);

  return gates === null ? null : held(gates[row.gate]);
}

function missedAt(figures: Record<string, unknown> | null, tau: number): number | null {
  const asymmetric = figures?.asymmetric;

  if (!Array.isArray(asymmetric) || asymmetric.length === 0) {
    return null;
  }
  const thresholds = held(asymmetric[0])?.thresholds;

  if (!Array.isArray(thresholds)) {
    return null;
  }
  const at = thresholds.map(held).find((one) => one !== null && numberOr(one.tau) === tau);

  return at === undefined || at === null ? null : numberOr(at.missed);
}

/** One line a gate, out of what its own run recorded. A gate whose run left no report keeps its line
 * and says what stopped it, rather than being left out of a table that is meant to be every gate. */
export function gateTableRows(ledger: TrainLedger, tau: number = TABLE_TAU): GateTableRow[] {
  return ledger.rows.map((row) => {
    const figures = gateFigures(row);
    const base = held(figures?.base);
    const moved = held(figures?.difference);

    return {
      gate: row.gate,
      node: row.node,
      rehearsal: row.rehearsal,
      questions: numberOr(figures?.questions),
      agreement: numberOr(figures?.agreement),
      balanced: numberOr(figures?.balanced),
      ece: numberOr(figures?.ece),
      baseAgreement: numberOr(base?.agreement),
      baseBalanced: numberOr(base?.balanced),
      baseEce: numberOr(base?.ece),
      agreementMoved: numberOr(moved?.agreement),
      balancedMoved: numberOr(moved?.balanced),
      eceMoved: numberOr(moved?.ece),
      missed: missedAt(figures, tau),
      missedTau: missedAt(figures, tau) === null ? null : tau,
      fault: figures === null
        ? row.fault ?? (row.state === "done" ? "이 실행은 보정 보고를 남기지 않았어요." : `학습이 ${row.state === "unreachable" ? "노드에 닿지 못해" : "끝나지"} 못했어요.`)
        : row.fault,
    };
  });
}

/** The asymmetric gates' own count, threshold by threshold. It stands apart from the table above
 * because a missed call is not an accuracy: it is a message that wanted an answer and would not have
 * had one. */
export function missedTableRows(ledger: TrainLedger): MissedTableRow[] {
  const rows: MissedTableRow[] = [];

  for (const row of ledger.rows) {
    const asymmetric = gateFigures(row)?.asymmetric;

    if (!Array.isArray(asymmetric)) {
      continue;
    }
    for (const one of asymmetric.map(held)) {
      if (one === null || !Array.isArray(one.thresholds)) {
        continue;
      }
      rows.push({
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
      });
    }
  }

  return rows;
}

const shown = (value: number | null, places = 3): string => value === null ? "—" : value.toFixed(places);
const moved = (value: number | null, places = 3): string =>
  value === null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(places)}`;

function laidOut(head: readonly string[], body: readonly (readonly string[])[]): string[] {
  const widths = head.map((_, column) => Math.max(...[head, ...body].map((line) => printedWidth(line[column] ?? ""))));
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column]! - printedWidth(cell)))).join("  ").trimEnd();

  return [line(head), line(widths.map((width) => "-".repeat(width))), ...body.map(line)];
}

const mark = runWord;

/** The per-gate table. Its first column is what the run was: a line of it, read on its own, still
 * says whether the figures beside it are a gate's or a rehearsal's. */
export function gateTableLines(rows: readonly GateTableRow[], tau: number = TABLE_TAU): string[] {
  if (rows.length === 0) {
    return ["게이트 표에 넣을 것이 없어요."];
  }
  const head = ["실험", "게이트", "노드", "문항", "기준 정확도", "정확도", "차이", "균형 정확도", "균형 차이", "보정(ECE)", "ECE 차이", `놓친 호출(τ${tau})`];
  const body = rows.map((row) => [
    mark(row.rehearsal), row.gate, row.node,
    row.questions === null ? "—" : String(row.questions),
    shown(row.baseAgreement), shown(row.agreement), moved(row.agreementMoved),
    shown(row.balanced), moved(row.balancedMoved),
    shown(row.ece), moved(row.eceMoved),
    row.missed === null ? "—" : String(row.missed),
  ]);
  const notes = rows.filter((row) => row.fault !== null).map((row) => `${row.gate}: ${row.fault}`);

  return [...laidOut(head, body), ...notes.length > 0 ? ["", ...notes] : []];
}

/** The missed calls of every gate that declares one settleable answer, threshold by threshold. */
export function missedTableLines(rows: readonly MissedTableRow[]): string[] {
  if (rows.length === 0) {
    return ["비대칭 게이트가 이 실행에는 없어요."];
  }
  const head = ["실험", "게이트", "질문", "Laya가 맡는 답", "τ", "맡은 수", "덮음", "놓친 호출", "놓친 비율"];
  const body = rows.flatMap((row) => row.thresholds.map((at) => [
    mark(row.rehearsal), row.gate, row.question, row.settles,
    at.tau.toFixed(2), String(at.settled), shown(at.coverage, 3), String(at.missed), shown(at.missedRate, 3),
  ]));
  const said = rows.map((row) =>
    `${row.gate}: 시험 문항 ${row.questions}개 가운데 답이 필요한 것 ${row.wanted}개. `
    + `놓친 호출은 답이 필요한데 Laya가 「${row.settles}」로 맡아 버린 것이에요.`);

  return [...laidOut(head, body), "", ...said];
}

/** Both tables as one sheet, with the line that says what these figures are worth. */
export function runTables(ledger: TrainLedger, tau: number = TABLE_TAU): string[] {
  const rows = gateTableRows(ledger, tau);
  const rehearsal = rows.some((row) => row.rehearsal);

  return [
    `# ${ledger.run} 검증 표`,
    "",
    ...rehearsal
      ? ["**리허설 데이터로 학습한 실행이에요.** 여기 수치는 기계가 제대로 실행되는지만 말하고, 게이트가 쓸 만한지는 말하지 않아요.", ""]
      : [],
    "## 게이트별",
    "",
    ...gateTableLines(rows, tau),
    "",
    "## 비대칭 게이트의 놓친 호출",
    "",
    ...missedTableLines(missedTableRows(ledger)),
    "",
    "## 노드별",
    "",
    ...trainLedgerLines(ledger),
  ];
}

export function tablesJson(ledger: TrainLedger, tau: number = TABLE_TAU): Record<string, unknown> {
  return {
    run: ledger.run,
    dataset: ledger.dataset,
    rehearsal: ledger.rehearsal,
    tau,
    gates: gateTableRows(ledger, tau),
    missed: missedTableRows(ledger),
    nodes: ledger.rows.map((row) => ({
      gate: row.gate, node: row.node, round: row.round, state: row.state, steps: row.steps,
      resumes: row.resumes, seconds: row.seconds, peakReservedBytes: row.peakReservedBytes,
      peakAllocatedBytes: row.peakAllocatedBytes, microBatch: row.microBatch, accumulate: row.accumulate,
      effectiveBatch: row.effectiveBatch, precision: row.precision, device: row.device,
      rehearsal: row.rehearsal,
    })),
  };
}
