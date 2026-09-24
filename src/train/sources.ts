import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { growingCounts, mergeGates, readsAsRehearsal } from "../gate-merge";
import { splitFiles } from "../laya-frozen";
import { gateDataFile, gatesFolder } from "../reference/tick";
import { dataPath, runFolder } from "../roots";
import { copyGateRows } from "./source";

import type { DatasetRow, DatasetSplit } from "../laya-dataset";
import type { GateBars, GateCopy, GateCount, GateSource } from "./source";

// The three kinds of source a pass reads (docs/training.md, 「Where the data comes from」). Each
// declares the bars its own gates are held to.

// A thousand rows is about a hundred and fifty test rows at the shares every source holds out.
export const rowFloor = 1_000;

// The reference gates' yes answers are a few in a hundred, so they wait for this many as well.
export const referenceYesFloor = 200;

// The reference data (docs/reference-data.md): one folder a gate, put in place whole by each of its
// passes, with the gate's counts beside its rows.
export function referenceSource(run: string, root: string = run.startsWith("/") ? run : dataPath("reference-data", run)): GateSource {
  const gates = join(root, gatesFolder);

  return {
    name: basename(root),
    rehearsal: false,
    counts: () => {
      if (!existsSync(gates)) {
        return `${gates} 가 없어요. 참조 데이터 회차를 먼저 돌리세요.`;
      }

      return readdirSync(gates).sort().filter((gate) => existsSync(join(gates, gate, gateDataFile))).map((gate): GateCount => {
        const data = JSON.parse(readFileSync(join(gates, gate, gateDataFile), "utf8")) as { rows: Record<DatasetSplit, number>; yes: number };

        return { gate, rows: data.rows, rarer: data.yes, series: "" };
      });
    },
    bars: () => ({ floor: rowFloor, rarer: referenceYesFloor }),
    copy: (gate, to) => copyGateRows(join(gates, gate), gate, to),
  };
}

// A judging run, read at its whole batches while its judging goes on (docs/gate-data.md, 「A run
// folder」). A gate started over is a series of its own, told apart by when its judging began.
export function judgingSource(run: string, rarer = 0, root: string = run.startsWith("/") ? run : runFolder(run)): GateSource {
  return {
    name: basename(root),
    rehearsal: false,
    counts: () => {
      const parts = growingCounts(root);

      return typeof parts === "string" ? parts : parts.map((part) => ({ gate: part.gate, rows: part.rows, rarer: part.rarer, series: part.started }));
    },
    bars: () => ({ floor: rowFloor, rarer }),
    copy: (gate, to): GateCopy | string => {
      const scratch = mkdtempSync(join(tmpdir(), "bmo-gate-cut-"));

      try {
        const merged = mergeGates({ root, into: scratch, gates: [gate], overwrite: true, growing: true });

        return typeof merged === "string" ? merged : copyGateRows(merged.folder, gate, to);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}

// A dataset folder: three split files holding the rows of any gates, such as a rehearsal. Its gates
// are held to nothing but having rows in every split.
export function folderSource(folder: string): GateSource {
  return {
    name: basename(folder),
    rehearsal: readsAsRehearsal(folder),
    counts: () => {
      const counted = new Map<string, Record<DatasetSplit, number>>();

      for (const [split, file] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
        const path = join(folder, file);

        if (!existsSync(path)) {
          return `${path} 가 없어요. 세 분할을 갖춘 데이터 폴더를 주세요.`;
        }

        for (const line of readFileSync(path, "utf8").split("\n").filter((one) => one.trim() !== "")) {
          const gate = (JSON.parse(line) as DatasetRow).gate;
          const rows = counted.get(gate) ?? { train: 0, calibration: 0, test: 0 };

          rows[split] += 1;
          counted.set(gate, rows);
        }
      }

      return [...counted].sort(([left], [right]) => left.localeCompare(right)).map(([gate, rows]) => ({ gate, rows, rarer: 0, series: "" }));
    },
    bars: (): GateBars => ({ floor: 0, rarer: 0 }),
    copy: (gate, to) => copyGateRows(folder, gate, to),
  };
}

// A source as a pass is told it: `reference:<run>`, `judging:<run>` or `folder:<path>`. This is the
// one place that knows there are three kinds.
export function sourceOf(said: string, options: { rarer?: number } = {}): GateSource | string {
  const cut = said.indexOf(":");
  const kind = cut < 0 ? "" : said.slice(0, cut);
  const where = cut < 0 ? "" : said.slice(cut + 1);

  if (where === "") {
    return `${said} 는 reference:<실행>, judging:<실행>, folder:<경로> 가운데 하나가 아니에요.`;
  }

  switch (kind) {
    case "reference":
      return referenceSource(where);
    case "judging":
      return judgingSource(where, options.rarer ?? 0);
    case "folder":
      return folderSource(where);
    default:
      return `${said} 는 reference:<실행>, judging:<실행>, folder:<경로> 가운데 하나가 아니에요.`;
  }
}
