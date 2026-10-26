import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { generationOf } from "./laya-audit";
import { addTokens, metaFile, noTokens, roadPriceNote, roadsOf } from "./laya-synth-run";
import { gateFolder } from "./roots";
import { readRunStanding } from "./gate-run";

import type { DatasetSplit } from "./laya-dataset";
import type { GateSynthesis } from "./laya-synth";
import type { SynthMeta, SynthRoad, TokenTally } from "./laya-synth-run";

// What a run cost and what it made, gate by gate (docs/gate-data.md 「The ledger」).
//
// The tokens are the whole of what there is to report. No road charges per token, so the ledger
// says that outright, each road the run was driven on naming what stands behind its counts — a
// zero left standing unexplained is read as free.
export const noPriceHere = "The ledger records tokens alone and no price. That is not a price of nothing: there is no price at all.";

export function priceLines(roads: readonly SynthRoad[]): string[] {
  return [...roads.map(roadPriceNote), noPriceHere];
}

export interface GateLedgerRow {
  gate: string;
  // What the model wrote, and what survived the generator's own filter.
  written: number;
  kept: number;
  splits: Record<DatasetSplit, number>;
  batchesDone: number;
  batchesPlanned: number;
  lostBatches: number;
  refused: Record<string, number>;
  // Fresh input and cache reads stand apart, because holding one thread per gate is what makes
  // them differ and a run that added them together could not show that it had worked.
  tokens: TokenTally;
  seconds: number;
  threadHeld: boolean;
  // The road or roads this gate was written on, and the model and effort driving it. More than one
  // road for a gate carried across roads. They are the gate's own: one run may build a gate on
  // another road while the rest ride codex, so no one of them is the run's.
  roads: SynthRoad[];
  model: string;
  effort: string;
}

// A model at an effort, as one of the run's gates was written with.
export interface LedgerModel {
  model: string;
  effort: string;
}

export interface RunLedger {
  root: string;
  // Every model and every road any of the run's gates was written with. A run of gates that all
  // shared one names one; a run that did not names them all rather than passing off one gate's as
  // the whole run's.
  models: LedgerModel[];
  roads: SynthRoad[];
  gates: GateLedgerRow[];
  totals: {
    written: number;
    kept: number;
    batchesDone: number;
    batchesPlanned: number;
    lostBatches: number;
    tokens: TokenTally;
    seconds: number;
  };
}

function metaIn(folder: string): SynthMeta | null {
  const path = join(folder, metaFile);

  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SynthMeta : null;
}

function secondsBetween(from: string | undefined, to: string | undefined): number {
  if (from === undefined || to === undefined) {
    return 0;
  }

  const took = Date.parse(to) - Date.parse(from);

  return Number.isFinite(took) && took > 0 ? Math.round(took / 1000) : 0;
}

// Every model-and-effort the run's gates were written with, each once and in the order the gates
// stand. A gate that recorded neither has nothing to name and is passed over rather than entered
// as a blank model somebody has to account for.
function distinctModels(rows: readonly GateLedgerRow[]): LedgerModel[] {
  const seen = new Map<string, LedgerModel>();

  for (const one of rows) {
    if (one.model !== "") {
      seen.set(`${one.model}\u0000${one.effort}`, { model: one.model, effort: one.effort });
    }
  }

  return [...seen.values()];
}

// The ledger for a run, read off the folders its gates wrote. A gate that never started is left
// out rather than entered as a row of zeroes, because a row of zeroes reads as a gate that ran and
// produced nothing.
export function readLedger(root: string, gates: readonly GateSynthesis[]): RunLedger | string {
  const standing = readRunStanding(root, gates);
  const rows: GateLedgerRow[] = [];
  let first = "";
  let last = "";

  for (const one of standing) {
    if (one.state === "not started") {
      continue;
    }

    const folder = gateFolder(root, one.gate);
    const meta = metaIn(folder);
    const generation = generationOf(folder, one.gate);
    const figures = meta?.gates.find((each) => each.gate === one.gate);

    if (meta !== null) {
      first = first === "" || meta.started < first ? meta.started : first;
      last = last === "" || meta.written > last ? meta.written : last;
    }

    rows.push({
      gate: one.gate,
      written: generation?.written ?? one.kept,
      kept: generation?.kept ?? one.kept,
      splits: figures?.splits ?? { train: 0, calibration: 0, test: 0 },
      batchesDone: one.done,
      batchesPlanned: one.planned,
      lostBatches: one.lostBatches,
      refused: one.refused,
      tokens: one.tokens,
      seconds: secondsBetween(meta?.started, meta?.written),
      threadHeld: one.threadHeld,
      // A frozen gate's meta is the account of what wrote it. A gate still writing has no meta
      // yet — it is written at freezing — so its standing answers instead, off the progress it has
      // been keeping since its first batch. A run of every gate is a day's work, and a ledger that
      // could name a road only once the gate had finished would answer a day after it was asked.
      roads: meta === null ? one.roads : roadsOf(meta),
      model: meta?.model ?? one.model,
      effort: meta?.effort ?? one.effort,
    });
  }

  if (rows.length === 0) {
    return `No gate has started under ${root} yet.`;
  }

  return {
    root,
    models: distinctModels(rows),
    roads: [...new Set(rows.flatMap((one) => one.roads))].sort(),
    gates: rows,
    totals: {
      written: rows.reduce((all, one) => all + one.written, 0),
      kept: rows.reduce((all, one) => all + one.kept, 0),
      batchesDone: rows.reduce((all, one) => all + one.batchesDone, 0),
      batchesPlanned: rows.reduce((all, one) => all + one.batchesPlanned, 0),
      lostBatches: rows.reduce((all, one) => all + one.lostBatches, 0),
      tokens: rows.reduce<TokenTally>((all, one) => addTokens(all, one.tokens), noTokens),
      // The run's own wall time, from the first gate starting to the last one finishing, which on
      // a run of gates written beside each other is shorter than their times added together.
      seconds: secondsBetween(first, last),
    },
  };
}

function clock(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  return seconds < 3_600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function modelWord(one: LedgerModel): string {
  return one.model === "" ? "?" : `${one.model} (${one.effort})`;
}

export function ledgerLines(ledger: RunLedger): string[] {
  const lines = ledger.gates.flatMap((one) => {
    const refused = Object.entries(one.refused).sort(([a], [b]) => a.localeCompare(b))
      .map(([why, count]) => `${why} ${count}`).join(", ");

    return [
      `${one.gate}`,
      `  rows written ${one.written} · rows kept ${one.kept} (train ${one.splits.train} · calibration ${one.splits.calibration} · test ${one.splits.test})`,
      `  batches ${one.batchesDone}/${one.batchesPlanned} · lost batches ${one.lostBatches} · rows refused ${refused === "" ? "none" : refused}`,
      `  fresh input ${one.tokens.inputTokens} · cache reads ${one.tokens.cacheReadTokens} · cache writes ${one.tokens.cacheWriteTokens} · output ${one.tokens.outputTokens}`,
      `  road ${one.roads.join(" → ") || "?"} · model ${modelWord(one)} · ${clock(one.seconds)}`
        + ` · ${one.threadHeld ? "held one thread" : "held no thread"}`,
    ];
  });

  return [
    `${ledger.root}`,
    `model ${ledger.models.map(modelWord).join(", ") || "?"}, road ${ledger.roads.join(", ") || "?"}`,
    "",
    ...lines,
    "",
    `in all ${ledger.gates.length} gates · rows written ${ledger.totals.written} · rows kept ${ledger.totals.kept}`
      + ` · batches ${ledger.totals.batchesDone}/${ledger.totals.batchesPlanned} · lost batches ${ledger.totals.lostBatches}`,
    `fresh input ${ledger.totals.tokens.inputTokens} · cache reads ${ledger.totals.tokens.cacheReadTokens}`
      + ` · cache writes ${ledger.totals.tokens.cacheWriteTokens} · output ${ledger.totals.tokens.outputTokens} · ${clock(ledger.totals.seconds)}`,
    "",
    ...priceLines(ledger.roads),
  ];
}
