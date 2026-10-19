import { datasetSplits } from "../laya-dataset";
import { totalRows } from "./source";

import type { CurvePoint } from "./curve";
import type { GateBars, GateCount } from "./source";

// Which gates a pass trains (docs/training.md, 「When a gate is trained」). The floors are read off a
// source's counts before any row is copied; the rows a gate has that its last point did not are
// read off the copy, which is the only place the ids are.

// A quarter of a gate's rows new to its last point before it is trained again.
export const newShare = 0.25;
// For a point made before ids were kept: a quarter more rows than it had.
export const growth = 1.25;

export interface Waiting {
  gate: string;
  rows: number;
  reason: string;
}

// Why a gate is below what its source holds it to, or null where it clears.
export function floorReason(count: GateCount, bars: GateBars): string | null {
  const rows = totalRows(count.rows);
  const empty = datasetSplits.filter((split) => count.rows[split] === 0);

  if (rows < bars.floor) {
    return `below the floor of ${bars.floor} rows`;
  }

  if (empty.length > 0) {
    return `the ${empty.join(", ")} split is empty`;
  }

  if (count.rarer < bars.rarer) {
    return `${count.rarer} of the rarer answer, below the floor of ${bars.rarer}`;
  }

  return null;
}

export interface Copied {
  rows: number;
  ids: ReadonlySet<string>;
  digest: string;
}

// Why a gate that clears its floors is not trained this pass, or null where it is. `series` is the
// gate's points of its own series, oldest first; `idsOf` reads the ids a point was trained on.
export function retrainReason(copied: Copied, series: readonly CurvePoint[], idsOf: (point: CurvePoint) => ReadonlySet<string> | null): string | null {
  const last = series.at(-1);

  if (last === undefined) {
    return null;
  }

  if (last.state !== "done") {
    const before = series.at(-2);
    const same = (point: CurvePoint | undefined): boolean =>
      point !== undefined && point.state !== "done" && (point.digest === undefined ? point.rows === copied.rows : point.digest === copied.digest);

    // Failed once: tried again. Failed twice on these very rows: wait for them to change.
    return same(last) && same(before) ? `failed twice on the same rows up to pass ${last.pass}, waiting for them to change` : null;
  }

  const trained = idsOf(last);

  if (trained === null) {
    const wanted = Math.ceil(last.rows * growth);

    return copied.rows >= wanted ? null : `${last.rows} rows at pass ${last.pass}, the next from ${wanted} rows`;
  }

  const fresh = [...copied.ids].filter((id) => !trained.has(id)).length;
  const wanted = Math.ceil(last.rows * newShare);

  return fresh >= wanted ? null : `${fresh} new rows since the ${last.rows} of pass ${last.pass}, the next from ${wanted}`;
}

// A gate's points of its own series: a gate whose rows were started over is compared only with the
// points made since.
export function seriesOf(points: readonly CurvePoint[], gate: string, series: string): CurvePoint[] {
  return points.filter((point) => point.gate === gate && (point.started ?? "") === series);
}
