import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runWord } from "../laya-rehearsal";
import { laidOut } from "./table";

// A pass's own record, one line a gate (docs/training.md, 「The ledger and the curve」). It is the raw
// form of the per-node table, and the calibration's report rides in it so the tables need no second
// transfer.

export const ledgerFile = "ledger.json";

export interface LedgerRow {
  gate: string;
  node: string;
  round: number;
  pass: string;
  rehearsal: boolean;
  state: "done" | "failed" | "unreachable";
  startedAt: string | null;
  endedAt: string | null;
  steps: number | null;
  epochs: number | null;
  resumes: number;
  seconds: number | null;
  peakReservedBytes: number | null;
  peakAllocatedBytes: number | null;
  microBatch: number | null;
  accumulate: number | null;
  effectiveBatch: number | null;
  precision: string | null;
  device: string | null;
  checkpoint: string | null;
  trainLog: string | null;
  calibrateLog: string | null;
  // The collected checkpoint the new one was measured beside, or null for the one it was trained from.
  beside: string | null;
  calibration: { agreement: number | null; balanced: number | null; ece: number | null } | null;
  report: Record<string, unknown> | null;
  collected: string[];
  collectFault: string | null;
  fault: string | null;
}

export interface Ledger {
  pass: string;
  source: string;
  rehearsal: boolean;
  started: string;
  ended: string;
  nodes: readonly string[];
  rows: LedgerRow[];
}

export function writeLedger(folder: string, ledger: Ledger): string {
  mkdirSync(folder, { recursive: true });

  const path = join(folder, ledgerFile);

  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);

  return path;
}

export function readLedger(folder: string): Ledger | null {
  const path = join(folder, ledgerFile);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const read = JSON.parse(readFileSync(path, "utf8")) as Partial<Ledger> & { run?: string; dataset?: string };

    if (typeof read !== "object" || read === null || !Array.isArray(read.rows)) {
      return null;
    }

    // A ledger written before passes measured beside the serving checkpoint names its pass as a run
    // and measured every gate beside the checkpoint it came from.
    return {
      pass: read.pass ?? read.run ?? "",
      source: read.source ?? read.dataset ?? "",
      rehearsal: read.rehearsal === true,
      started: read.started ?? "",
      ended: read.ended ?? "",
      nodes: read.nodes ?? [],
      rows: read.rows.map((row) => ({ ...row, pass: row.pass ?? read.pass ?? read.run ?? "", beside: row.beside ?? null })),
    };
  } catch {
    return null;
  }
}

const gb = (bytes: number | null): string => bytes === null ? "—" : `${(bytes / 1e9).toFixed(2)} GB`;

/** The per-node table: what each gate's run took on the node that ran it. */
export function ledgerLines(ledger: Ledger): string[] {
  const head = ["실험", "게이트", "노드", "차례", "상태", "스텝", "이어감", "걸린 시간", "VRAM 최대", "배치", "정밀도"];
  const body = ledger.rows.map((row) => [
    runWord(row.rehearsal),
    row.gate,
    row.node,
    String(row.round),
    row.state === "done" ? "끝남" : row.state === "unreachable" ? "닿지 않음" : "실패",
    row.steps === null ? "—" : String(row.steps),
    String(row.resumes),
    row.seconds === null ? "—" : `${Math.round(row.seconds)}초`,
    gb(row.peakReservedBytes),
    row.microBatch === null ? "—" : `${row.microBatch}×${row.accumulate ?? "?"}=${row.effectiveBatch ?? "?"}`,
    row.precision ?? "—",
  ]);
  const notes = ledger.rows.filter((row) => row.fault !== null).map((row) => `${row.gate} (${row.node}): ${row.fault}`);

  return [
    ...ledger.rehearsal ? ["리허설 데이터로 학습한 것이라 여기 수치는 기계가 제대로 실행되는지만 말해요."] : [],
    ...laidOut(head, body),
    ...notes.length > 0 ? ["", ...notes] : [],
  ];
}
