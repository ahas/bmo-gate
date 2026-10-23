import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitFiles } from "../laya-frozen";
import { datasetSplits } from "../laya-dataset";
import { askedNow } from "../laya-wording";

import type { DatasetRow, DatasetSplit } from "../laya-dataset";

// Where a training pass's gates come from (docs/training.md, 「Where the data comes from」). A source
// knows its own gates and the bars they are held to; the driver asks it the same things whatever
// kind of source it is.

export interface GateBars {
  // The fewest rows the gate is trained on, and the fewest questions of its rarer answer.
  floor: number;
  rarer: number;
}

export interface GateCount {
  gate: string;
  rows: Record<DatasetSplit, number>;
  rarer: number;
  // What sets one run of the gate's rows apart from a run started over, where the source has one.
  series: string;
}

export interface GateCopy {
  folder: string;
  rows: Record<DatasetSplit, number>;
  ids: string[];
  digest: string;
}

export interface GateSource {
  // What the pass names are made from and the curve is kept under.
  readonly name: string;
  readonly rehearsal: boolean;
  counts(): GateCount[] | string;
  bars(gate: string): GateBars;
  // The gate's rows now, copied into a folder of their own, which is what a pass trains on for its
  // whole life however the source moves under it.
  copy(gate: string, to: string): GateCopy | string;
}

export function totalRows(rows: Record<DatasetSplit, number>): number {
  return datasetSplits.reduce((sum, split) => sum + rows[split], 0);
}

// One gate's rows out of a folder holding the three split files, written into a folder of its own.
// Where the folder holds several gates, only this gate's rows are taken. Each is copied asking its gate's
// own wording (docs/gate-data.md, 「A question reworded」); a row that already does is copied as it stands.
export function copyGateRows(from: string, gate: string, to: string): GateCopy | string {
  const rows = { train: 0, calibration: 0, test: 0 } as Record<DatasetSplit, number>;
  const ids: string[] = [];
  const digest = createHash("sha256");
  const kept: [string, string][] = [];

  for (const split of datasetSplits) {
    const path = join(from, splitFiles[split]);

    if (!existsSync(path)) {
      return `${path} is missing.`;
    }

    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").filter((line) => {
      try {
        return (JSON.parse(line) as DatasetRow).gate === gate;
      } catch {
        return false;
      }
    }).map((line) => {
      const row = JSON.parse(line) as DatasetRow;
      const asked = askedNow(row);

      return asked === row ? line : JSON.stringify(asked);
    });

    rows[split] = lines.length;
    ids.push(...lines.map((line) => (JSON.parse(line) as DatasetRow).id));

    const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;

    digest.update(text);
    kept.push([splitFiles[split], text]);
  }

  mkdirSync(to, { recursive: true });

  for (const [file, text] of kept) {
    writeFileSync(join(to, file), text);
  }

  return { folder: to, rows, ids, digest: digest.digest("hex").slice(0, 16) };
}
