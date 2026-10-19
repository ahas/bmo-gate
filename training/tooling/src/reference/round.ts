import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dataPath, homeDir } from "../roots";
import { ledgerFile } from "../train/ledger";

import type { Ledger } from "../train/ledger";

// A round of the reference gates' data, run when the owner asks for one (docs/reference-data.md
// 「A round on request」): a pass of the data, then a training pass over it that gives way to other
// work, in a transient unit of its own so it outlives whoever started it.

export const roundUnit = "bmo-gate-reference-round";
export const roundsFile = "rounds.jsonl";

// The memory a round waits for before it starts: the pass of the data holds up to about eleven
// gigabytes at its peak, and the jobs beside it keep what is left.
export const roundMemoryBytes = 12 * 1024 ** 3;

export function roundFolder(run: string): string {
  return run.startsWith("/") ? run : dataPath("reference-data", run);
}

export interface RoundStart {
  run: string;
  spare: readonly string[];
  asked: string;
  // The checkout copy of this directory the unit runs in, and the bun that runs it.
  checkout: string;
  bun: string;
}

/** The whole systemd-run line that starts a round. The unit reads the gate's settings where the gate
 * reads them, since the pass of the data builds the gate's inputs with the gate's own code. */
export function roundUnitLine(start: RoundStart): string[] {
  const home = homeDir();

  return [
    "systemd-run", "--user", "--quiet", "--collect", `--unit=${roundUnit}`,
    `--property=WorkingDirectory=${start.checkout}`,
    `--property=EnvironmentFile=${dataPath("env", "bot.env")}`,
    `--setenv=PATH=${home}/.bun/bin:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    start.bun, "scripts/reference-round.ts", start.run, "--in-unit", "--asked", start.asked,
    ...start.spare.flatMap((unit) => ["--spare", unit]),
  ];
}

export interface StepRecord {
  seconds: number;
  exit: number;
}

export interface GateSeconds {
  gate: string;
  node: string;
  state: string;
  // The training's own seconds, and when the gate's whole run on the node began and ended.
  seconds: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RoundRecord {
  asked: string;
  started: string;
  ended: string;
  waitedSeconds: number;
  data: StepRecord;
  training: StepRecord;
  // The training run this round's pass made, or null where it trained nothing.
  trainingRun: string | null;
  gates: GateSeconds[];
}

/** Each gate's line of the training run's ledger, where the pass trained anything. */
export function gateSeconds(runFolder: string): GateSeconds[] | null {
  const path = join(runFolder, ledgerFile);

  if (!existsSync(path)) {
    return null;
  }

  const ledger = JSON.parse(readFileSync(path, "utf8")) as Ledger;

  return ledger.rows.map((row) => ({ gate: row.gate, node: row.node, state: row.state, seconds: row.seconds, startedAt: row.startedAt, endedAt: row.endedAt }));
}

export function appendRound(folder: string, record: RoundRecord): void {
  appendFileSync(join(folder, roundsFile), `${JSON.stringify(record)}\n`);
}
