import { describe, expect, test } from "bun:test";

import {
  REAL_WORD,
  REHEARSAL_WORD,
  TABLE_TAU,
  gateTableLines,
  gateTableRows,
  missedTableLines,
  missedTableRows,
  runTables,
  tablesJson,
} from "./laya-tables";

import type { TrainLedger, TrainLedgerRow } from "./laya-train";

function thresholds(): Array<Record<string, number>> {
  return [
    { tau: 0.5, settled: 7, coverage: 0.6364, missed: 4, missed_rate: 0.5714 },
    { tau: 0.9, settled: 2, coverage: 0.1818, missed: 1, missed_rate: 0.1429 },
    { tau: 0.99, settled: 0, coverage: 0, missed: 0, missed_rate: 0 },
  ];
}

/** A report in the shape the calibration writes, so the table is assembled from what really comes
 * off a run rather than from a shape invented here. */
function report(gate: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "laya-calibration",
    model: `checkpoints/run-${gate}`,
    base_model: "/hub/multilingual",
    thresholds: [0.5, 0.9, 0.99],
    overall: { questions: 11, agreement: 0.5455 },
    gates: {
      [gate]: {
        questions: 11,
        agreement: 0.5455,
        balanced: 0.5893,
        ece: 0.2548,
        answers: { false: 7, true: 4 },
        correct: { false: 3, true: 3 },
        base: { questions: 11, agreement: 0.3636, balanced: 0.2857, ece: 0.4722 },
        difference: { agreement: 0.1819, balanced: 0.3036, ece: -0.2174 },
        asymmetric: [],
        ...changes,
      },
    },
  };
}

function row(gate: string, changes: Partial<TrainLedgerRow> = {}): TrainLedgerRow {
  return {
    gate, node: "n2", round: 1, dataset: "rehearsal-713", rehearsal: true, state: "done",
    startedAt: "2026-09-23T08:00:00Z", endedAt: "2026-09-23T08:10:00Z", steps: 8, epochs: 1, resumes: 0,
    seconds: 141.2, peakReservedBytes: 6_790_000_000, peakAllocatedBytes: 5_100_000_000, microBatch: 4,
    accumulate: 16, effectiveBatch: 64, precision: "bf16", device: "NVIDIA GeForce RTX 4070",
    items: { [gate]: 36 }, checkpoint: `checkpoints/run-${gate}`, trainLog: null, calibrateLog: null,
    calibration: { agreement: 0.5455, balanced: 0.5893, ece: 0.2548 }, report: report(gate),
    collected: [], collectFault: null, fault: null, ...changes,
  };
}

function ledger(rows: TrainLedgerRow[], rehearsal = true): TrainLedger {
  return {
    run: "rehearsal-713", dataset: "rehearsal-713", rehearsal,
    started: "2026-09-23T08:00:00Z", ended: "2026-09-23T08:30:00Z", nodes: ["n2", "n3"], rows,
  };
}

describe("the per-gate table", () => {
  test("every figure comes off the run's own report", () => {
    const [read] = gateTableRows(ledger([row("content-judge")]));

    expect(read!.gate).toBe("content-judge");
    expect(read!.questions).toBe(11);
    expect(read!.baseAgreement).toBe(0.3636);
    expect(read!.agreement).toBe(0.5455);
    expect(read!.agreementMoved).toBe(0.1819);
    expect(read!.balanced).toBe(0.5893);
    expect(read!.balancedMoved).toBe(0.3036);
    expect(read!.ece).toBe(0.2548);
    expect(read!.eceMoved).toBe(-0.2174);
    expect(read!.fault).toBeNull();
  });

  test("the difference reads as a movement, up or down", () => {
    const lines = gateTableLines(gateTableRows(ledger([row("content-judge")]))).join("\n");

    expect(lines).toContain("+0.182");
    expect(lines).toContain("−0.217");
  });

  test("a gate whose run left no report keeps its line and says what stopped it", () => {
    const rows = gateTableRows(ledger([
      row("sanitizer", { report: null, state: "failed", fault: "학습이 시작되자마자 멈췄어요" }),
      row("reply-wanted", { report: null, state: "unreachable", fault: null }),
      row("content-judge", { report: null, state: "done", fault: null }),
    ]));

    expect(rows.map((one) => one.gate)).toEqual(["sanitizer", "reply-wanted", "content-judge"]);
    expect(rows[0]!.agreement).toBeNull();
    expect(rows[0]!.fault).toContain("시작되자마자");
    expect(rows[1]!.fault).toContain("노드에 닿지");
    expect(rows[2]!.fault).toContain("보정 보고를 남기지 않았어요");
    expect(gateTableLines(rows).join("\n")).toContain("sanitizer");
  });

  test("a gate measured without a base shows no difference rather than a zero", () => {
    const without = report("sanitizer", { base: null, difference: null });
    const [read] = gateTableRows(ledger([row("sanitizer", { report: without })]));

    expect(read!.agreement).toBe(0.5455);
    expect(read!.baseAgreement).toBeNull();
    expect(read!.agreementMoved).toBeNull();
    expect(gateTableLines([read!]).join("\n")).toContain("—");
  });

  test("nothing to put in a table says so rather than printing an empty one", () => {
    expect(gateTableLines([])).toEqual(["게이트 표에 넣을 것이 없어요."]);
  });
});

describe("the missed calls of an asymmetric gate", () => {
  const asymmetric = report("reply-wanted", {
    asymmetric: [{ question: "forBmo", settles: "false", questions: 11, wanted: 7, thresholds: thresholds() }],
  });

  test("the count stands in the gate's line at the threshold the table shows", () => {
    const [read] = gateTableRows(ledger([row("reply-wanted", { report: asymmetric })]), 0.9);

    expect(read!.missed).toBe(1);
    expect(read!.missedTau).toBe(0.9);
  });

  test("another threshold is another count", () => {
    expect(gateTableRows(ledger([row("reply-wanted", { report: asymmetric })]), 0.5)[0]!.missed).toBe(4);
  });

  test("a gate that settles nothing has no count at all", () => {
    expect(gateTableRows(ledger([row("content-judge")]))[0]!.missed).toBeNull();
  });

  test("the whole ladder stands in its own table", () => {
    const rows = missedTableRows(ledger([row("reply-wanted", { report: asymmetric }), row("content-judge")]));

    expect(rows.length).toBe(1);
    expect(rows[0]!.gate).toBe("reply-wanted");
    expect(rows[0]!.question).toBe("forBmo");
    expect(rows[0]!.settles).toBe("false");
    expect(rows[0]!.wanted).toBe(7);
    expect(rows[0]!.thresholds.map((one) => one.tau)).toEqual([0.5, 0.9, 0.99]);
    expect(rows[0]!.thresholds[0]!.missedRate).toBe(0.5714);
  });

  test("what a missed call is stands under the table in words", () => {
    const lines = missedTableLines(missedTableRows(ledger([row("reply-wanted", { report: asymmetric })]))).join("\n");

    expect(lines).toContain("놓친 호출은 답이 필요한데");
    expect(lines).toContain("「false」");
    expect(lines).toContain("0.90");
  });

  test("a run with no asymmetric gate in it says so", () => {
    expect(missedTableLines(missedTableRows(ledger([row("content-judge")])))).toEqual(["비대칭 게이트가 이 실행에는 없어요."]);
  });
});

describe("a rehearsal figure can never be read as evidence", () => {
  test("every line of every table carries what the run was", () => {
    const sheet = runTables(ledger([row("reply-wanted", {
      report: report("reply-wanted", {
        asymmetric: [{ question: "forBmo", settles: "false", questions: 11, wanted: 7, thresholds: thresholds() }],
      }),
    })]));
    const figures = sheet.filter((line) => line.includes("reply-wanted") && !line.startsWith("#") && !line.includes("시험 문항"));

    expect(figures.length).toBeGreaterThanOrEqual(4);
    for (const line of figures) {
      expect(line).toContain(REHEARSAL_WORD);
    }
  });

  test("the sheet says it at the top as well", () => {
    expect(runTables(ledger([row("content-judge")])).join("\n")).toContain("리허설 데이터로 학습한 실행이에요");
  });

  test("a real run is marked as one and carries no rehearsal warning", () => {
    const real = ledger([row("content-judge", { rehearsal: false })], false);
    const sheet = runTables(real).join("\n");

    expect(sheet).not.toContain("리허설 데이터로 학습한 실행이에요");
    expect(gateTableLines(gateTableRows(real)).join("\n")).toContain(REAL_WORD);
  });

  test("one rehearsal line among real ones is still marked on its own line", () => {
    const mixed = ledger([row("content-judge", { rehearsal: false }), row("sanitizer")], false);
    const lines = gateTableLines(gateTableRows(mixed));

    expect(lines.find((line) => line.includes("content-judge"))).toContain(REAL_WORD);
    expect(lines.find((line) => line.includes("sanitizer"))).toContain(REHEARSAL_WORD);
  });
});

describe("the sheet as a whole", () => {
  test("it carries the three tables the run is judged on", () => {
    const sheet = runTables(ledger([row("content-judge")])).join("\n");

    expect(sheet).toContain("## 게이트별");
    expect(sheet).toContain("## 비대칭 게이트의 놓친 호출");
    expect(sheet).toContain("## 노드별");
    // The per-node table is the ledger's own, so instruction 9's figures are not written twice.
    expect(sheet).toContain("6.79 GB");
    expect(sheet).toContain("4×16=64");
    expect(sheet).toContain("bf16");
  });

  test("the threshold the table shows is named in its heading", () => {
    expect(gateTableLines(gateTableRows(ledger([row("content-judge")])), 0.95).join("\n")).toContain("τ0.95");
    expect(TABLE_TAU).toBe(0.9);
  });

  test("the same figures come back as numbers for anything that reads them", () => {
    const read = tablesJson(ledger([row("content-judge")]));

    expect(read.run).toBe("rehearsal-713");
    expect(read.rehearsal).toBe(true);
    expect((read.gates as Array<{ agreement: number }>)[0]!.agreement).toBe(0.5455);
    expect((read.nodes as Array<{ peakReservedBytes: number }>)[0]!.peakReservedBytes).toBe(6_790_000_000);
    expect((read.nodes as Array<{ precision: string }>)[0]!.precision).toBe("bf16");
  });
});
