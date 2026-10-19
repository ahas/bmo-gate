import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { growingCounts, mergeGates, rarerOf, readsAsRehearsal } from "../gate-merge";
import { datasetSplits } from "../laya-dataset";
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
        return `${gates} does not exist. Run a round of the reference data first.`;
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
          return `${path} does not exist. Give a data folder holding all three splits.`;
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

// The rows a top-up run holds for one gate, read at its whole batches the way a judging run is, and
// only its training and calibration: the test stays the topped-up source's own.
function topUpRows(root: string, gate: string): string[] | string {
  const parts = growingCounts(root);

  if (typeof parts === "string") {
    return parts;
  }

  if (!parts.some((part) => part.gate === gate)) {
    return [];
  }

  const scratch = mkdtempSync(join(tmpdir(), "bmo-gate-topup-"));

  try {
    const merged = mergeGates({ root, into: scratch, gates: [gate], overwrite: true, growing: true });

    if (typeof merged === "string") {
      return merged;
    }

    return (["train", "calibration"] as const).flatMap((split) => readLines(join(merged.folder, splitFiles[split])))
      .filter((line) => (JSON.parse(line) as DatasetRow).gate === gate);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "") : [];
}

// The source's own copy of a gate with a top-up run's rows added to its training and calibration,
// each in the split it was made in.
function copyToppedUp(base: GateSource, root: string, gate: string, to: string): GateCopy | string {
  const own = base.copy(gate, to);

  if (typeof own === "string") {
    return own;
  }

  const added = topUpRows(root, gate);

  if (typeof added === "string") {
    return added;
  }

  const standing = new Set(own.ids);

  for (const line of added) {
    const row = JSON.parse(line) as DatasetRow;

    if (!standing.has(row.id)) {
      appendFileSync(join(to, splitFiles[row.split]), `${line}\n`);
    }
  }

  return copyGateRows(to, gate, to);
}

// A source topped up with a top-up run's rows for the rarer answer the rooms hold too little of
// (docs/training.md, 「Where the data comes from」). Its bars are the source's own, and it is named
// after both so its curve is a series of its own.
export function toppedUp(base: GateSource, run: string, root: string = runFolder(run)): GateSource {
  return {
    // Joined by a dot, which a checkpoint's run name takes where a plus is refused.
    name: `${base.name}.${basename(root)}`,
    rehearsal: base.rehearsal,
    counts: () => {
      const counted = base.counts();

      if (typeof counted === "string") {
        return counted;
      }

      const scratch = mkdtempSync(join(tmpdir(), "bmo-gate-topup-count-"));

      try {
        const out: GateCount[] = [];

        for (const count of counted) {
          const copy = copyToppedUp(base, root, count.gate, join(scratch, count.gate));

          if (typeof copy === "string") {
            return copy;
          }

          const rows = datasetSplits.flatMap((split) => readLines(join(copy.folder, splitFiles[split])))
            .map((line) => JSON.parse(line) as DatasetRow);

          out.push({ ...count, rows: copy.rows, rarer: rarerOf(rows) });
        }

        return out;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    bars: (gate) => base.bars(gate),
    copy: (gate, to) => copyToppedUp(base, root, gate, to),
  };
}

// A source as a pass is told it: `reference:<run>`, `judging:<run>` or `folder:<path>`. This is the
// one place that knows there are three kinds.
export function sourceOf(said: string, options: { rarer?: number } = {}): GateSource | string {
  const cut = said.indexOf(":");
  const kind = cut < 0 ? "" : said.slice(0, cut);
  const where = cut < 0 ? "" : said.slice(cut + 1);

  if (where === "") {
    return `${said} is none of reference:<run>, judging:<run>, folder:<path>.`;
  }

  switch (kind) {
    case "reference":
      return referenceSource(where);
    case "judging":
      return judgingSource(where, options.rarer ?? 0);
    case "folder":
      return folderSource(where);
    default:
      return `${said} is none of reference:<run>, judging:<run>, folder:<path>.`;
  }
}
