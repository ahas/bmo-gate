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
  const head = ["run", "gate", "node", "round", "state", "steps", "resumes", "took", "VRAM peak", "batch", "precision"];
  const body = ledger.rows.map((row) => [
    runWord(row.rehearsal),
    row.gate,
    row.node,
    String(row.round),
    row.state === "done" ? "done" : row.state === "unreachable" ? "unreachable" : "failed",
    row.steps === null ? "—" : String(row.steps),
    String(row.resumes),
    row.seconds === null ? "—" : `${Math.round(row.seconds)}s`,
    gb(row.peakReservedBytes),
    row.microBatch === null ? "—" : `${row.microBatch}×${row.accumulate ?? "?"}=${row.effectiveBatch ?? "?"}`,
    row.precision ?? "—",
  ]);
  const notes = ledger.rows.filter((row) => row.fault !== null).map((row) => `${row.gate} (${row.node}): ${row.fault}`);

  return [
    ...ledger.rehearsal ? ["Trained on rehearsal data, so these figures say only whether the machinery runs."] : [],
    ...laidOut(head, body),
    ...notes.length > 0 ? ["", ...notes] : [],
  ];
}
