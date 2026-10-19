import { describe, expect, test } from "bun:test";

import { floorReason, retrainReason, seriesOf } from "../../../training/tooling/src/train/readiness";

import type { CurvePoint } from "../../../training/tooling/src/train/curve";

const count = (train: number, calibration: number, test: number, rarer = 0) => ({ gate: "g", rows: { train, calibration, test }, rarer, series: "" });

function point(pass: number, rows: number, state: CurvePoint["state"], digest?: string): CurvePoint {
  return {
    pass, at: "t", run: "r", training: `r-p${pass}`, gate: "g", started: "", rows, train: rows, calibration: 0, test: 0, digest,
    node: "alpha", state, agreement: null, balanced: null, ece: null, seconds: null, fault: null,
  };
}

describe("floorReason", () => {
  test("holds a gate to its rows, then to every split, then to its rarer answer", () => {
    expect(floorReason(count(500, 100, 100), { floor: 1_000, rarer: 0 })).toBe("below the floor of 1000 rows");
    expect(floorReason(count(1_000, 100, 0), { floor: 1_000, rarer: 0 })).toBe("the test split is empty");
    expect(floorReason(count(800, 150, 150, 120), { floor: 1_000, rarer: 200 })).toBe("120 of the rarer answer, below the floor of 200");
    expect(floorReason(count(800, 150, 150, 250), { floor: 1_000, rarer: 200 })).toBeNull();
  });
});

describe("retrainReason", () => {
  const ids = (from: number, many: number) => new Set(Array.from({ length: many }, (_, at) => `id-${from + at}`));

  test("trains a gate never trained", () => {
    expect(retrainReason({ rows: 10, ids: ids(0, 10), digest: "d" }, [], () => null)).toBeNull();
  });

  test("trains again once a quarter of the rows are new to the last point, grown or changed", () => {
    const last = point(1, 100, "done");
    const trained = ids(0, 100);

    expect(retrainReason({ rows: 100, ids: ids(20, 100), digest: "d" }, [last], () => trained)).toBe("20 new rows since the 100 of pass 1, the next from 25");
    expect(retrainReason({ rows: 100, ids: ids(25, 100), digest: "d" }, [last], () => trained)).toBeNull();
  });

  test("reads a point made before ids were kept by its rows alone", () => {
    expect(retrainReason({ rows: 124, ids: ids(0, 124), digest: "d" }, [point(1, 100, "done")], () => null)).toBe("100 rows at pass 1, the next from 125 rows");
    expect(retrainReason({ rows: 125, ids: ids(0, 125), digest: "d" }, [point(1, 100, "done")], () => null)).toBeNull();
  });

  test("tries a failed gate once more, and waits after two failures on the same rows", () => {
    expect(retrainReason({ rows: 100, ids: ids(0, 100), digest: "d" }, [point(1, 100, "failed", "d")], () => null)).toBeNull();
    expect(retrainReason({ rows: 100, ids: ids(0, 100), digest: "d" }, [point(1, 100, "failed", "d"), point(2, 100, "failed", "d")], () => null))
      .toBe("failed twice on the same rows up to pass 2, waiting for them to change");
    expect(retrainReason({ rows: 100, ids: ids(0, 100), digest: "e" }, [point(1, 100, "failed", "d"), point(2, 100, "failed", "d")], () => null)).toBeNull();
  });
});

describe("seriesOf", () => {
  test("compares a gate started over only with its own points", () => {
    const old = { ...point(1, 10, "done"), started: "a" };
    const fresh = { ...point(2, 10, "done"), started: "b" };

    expect(seriesOf([old, fresh], "g", "b")).toEqual([fresh]);
  });
});
