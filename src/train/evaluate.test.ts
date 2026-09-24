import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "../scratch";
import { gateTableRows, measuredOf, missedTableRows, passTables } from "./evaluate";
import { unfinishedRow } from "./gate-run";
import { readLedger } from "./ledger";

import type { Ledger } from "./ledger";

const figures = (agreement: number, balanced: number, yes: [number, number]) => ({
  questions: 100, agreement, balanced, ece: 0.05, answers: { false: 100 - yes[0], true: yes[0] }, correct: { false: 90, true: yes[1] },
});

function ledger(rehearsal = false): Ledger {
  const done = {
    ...unfinishedRow("room-rules", "n2", 1, { pass: "ref-1-p0001", rehearsal, beside: "room-rules/real-1-hand/step-000044" }, "t"),
    state: "done" as const,
    report: {
      kind: "laya-calibration",
      gates: {
        "room-rules": { ...figures(0.9, 0.8, [10, 7]), base: figures(0.85, 0.6, [10, 2]) },
        "reply-wanted": {},
      },
    },
  };
  const asym = {
    ...unfinishedRow("reply-wanted", "n3", 1, { pass: "ref-1-p0001", rehearsal, beside: null }, "t"),
    state: "done" as const,
    report: {
      kind: "laya-calibration",
      gates: { "reply-wanted": { ...figures(0.9, 0.9, [50, 45]), asymmetric: [{ question: "forBmo", settles: "false", questions: 100, wanted: 50, thresholds: [{ tau: 0.9, settled: 30, coverage: 0.3, missed: 2, missed_rate: 0.04 }] }] } },
    },
  };
  const broken = { ...unfinishedRow("library-knowledge", "n4", 1, { pass: "ref-1-p0001", rehearsal, beside: null }, "t"), fault: "노드가 답하지 않아요" };

  return { pass: "ref-1-p0001", source: "ref-1", rehearsal, started: "s", ended: "e", nodes: ["n2", "n3", "n4"], rows: [done, asym, broken] };
}

describe("the before-and-after table", () => {
  test("sets the new checkpoint beside the one it was measured against, yes answers given back counted apart", () => {
    const row = gateTableRows(ledger())[0]!;

    expect(row.beside).toBe("room-rules/real-1-hand/step-000044");
    expect(row.before).toEqual({ agreement: 0.85, balanced: 0.6, yes: 0.2, ece: 0.05 });
    expect(row.after).toEqual({ agreement: 0.9, balanced: 0.8, yes: 0.7, ece: 0.05 });
  });

  test("a gate whose run left no report keeps its line and says what stopped it", () => {
    expect(gateTableRows(ledger())[2]).toMatchObject({ gate: "library-knowledge", after: null, fault: "노드가 답하지 않아요" });
  });

  test("yes given back is none where the test held no yes", () => {
    expect(measuredOf({ answers: { false: 3 }, correct: { false: 3 } })!.yes).toBeNull();
  });
});

describe("the missed calls", () => {
  test("stand threshold by threshold for a gate that declares a settleable answer", () => {
    expect(missedTableRows(ledger())).toMatchObject([{ gate: "reply-wanted", settles: "false", thresholds: [{ tau: 0.9, missed: 2, missedRate: 0.04 }] }]);
    expect(gateTableRows(ledger())[1]!.missed).toBe(2);
  });
});

describe("the sheet", () => {
  test("says on every line of a rehearsal's tables that it is one", () => {
    const sheet = passTables(ledger(true));
    const lines = sheet.filter((line) => line.includes("room-rules"));

    expect(sheet.join("\n")).toContain("리허설 데이터로 학습한 회차예요");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.includes("리허설"))).toBe(true);
  });

  test("reads a ledger written before passes named themselves", () => {
    const where = scratchDir("bmo-train-evaluate-");

    mkdirSync(where, { recursive: true });
    writeFileSync(join(where, "ledger.json"), JSON.stringify({ run: "real-1-p0003", dataset: "real-1-p0003", rehearsal: false, rows: [{ gate: "a", dataset: "real-1-p0003" }] }));

    expect(readLedger(where)).toMatchObject({ pass: "real-1-p0003", source: "real-1-p0003", rows: [{ pass: "real-1-p0003", beside: null }] });
  });
});
