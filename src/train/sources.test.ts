import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { splitFiles } from "../laya-frozen";
import { freezeBatch, noTokens, writeProgress } from "../laya-synth-run";
import { gateFolder } from "../roots";
import { scratchDir } from "../scratch";
import { folderSource, referenceSource, sourceOf, toppedUp } from "./sources";

import type { DatasetRow, DatasetSplit } from "../laya-dataset";

const root = scratchDir("bmo-train-sources-");
let made = 0;

function folder(): string {
  made += 1;
  const where = join(root, `case-${made}`);

  mkdirSync(where, { recursive: true });

  return where;
}

const row = (gate: string, id: string, split: DatasetSplit) => JSON.stringify({ id, gate, split, state: "\"s\"", questions: "{}", gold: "{}" });

function splits(where: string, rows: Record<DatasetSplit, string[]>): void {
  mkdirSync(where, { recursive: true });

  for (const [split, file] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
    writeFileSync(join(where, file), rows[split].length === 0 ? "" : `${rows[split].join("\n")}\n`);
  }
}

describe("referenceSource", () => {
  test("reads each gate's counts off its data file, holds it to its yes answers, and copies its rows", () => {
    const run = folder();
    const gate = join(run, "gates", "room-rules");

    splits(gate, { train: [row("room-rules", "a", "train")], calibration: [row("room-rules", "b", "calibration")], test: [] });
    writeFileSync(join(gate, "data.json"), JSON.stringify({ gate: "room-rules", rows: { train: 1, calibration: 1, test: 0 }, yes: 7 }));

    const source = referenceSource(run);
    const copy = source.copy("room-rules", join(folder(), "copy"));

    expect(source.counts()).toEqual([{ gate: "room-rules", rows: { train: 1, calibration: 1, test: 0 }, rarer: 7, series: "" }]);
    expect(source.bars("room-rules")).toEqual({ floor: 1_000, rarer: 200 });
    expect(typeof copy === "string" ? copy : copy.ids).toEqual(["a", "b"]);
  });

  test("says so where no pass has put its gates in place", () => {
    expect(referenceSource(folder()).counts()).toContain("참조 데이터 회차를 먼저");
  });
});

describe("folderSource", () => {
  test("counts every gate a dataset folder holds and copies one gate's rows alone", () => {
    const where = folder();

    splits(where, {
      train: [row("a", "a1", "train"), row("b", "b1", "train")],
      calibration: [row("a", "a2", "calibration")],
      test: [row("a", "a3", "test")],
    });

    const source = folderSource(where);
    const to = join(folder(), "a");

    source.copy("a", to);

    expect(source.counts()).toEqual([
      { gate: "a", rows: { train: 1, calibration: 1, test: 1 }, rarer: 0, series: "" },
      { gate: "b", rows: { train: 1, calibration: 0, test: 0 }, rarer: 0, series: "" },
    ]);
    expect(readFileSync(join(to, splitFiles.train), "utf8")).not.toContain("b1");
  });
});

describe("toppedUp", () => {
  const gold = (yes: number) => JSON.stringify({ keeps: { type: "noul", noul: yes, probabilities: { true: yes, false: 1 - yes } } });
  const judged = (id: string, split: DatasetSplit, yes: number) =>
    JSON.stringify({ id, gate: "content-judge", split, state: "\"s\"", questions: "{}", gold: gold(yes) });

  // A top-up run with two whole batches of the rarer answer, one of its rows landed in the test.
  function topUpRun(): string {
    const run = folder();
    const gate = gateFolder(run, "content-judge");

    writeProgress(gate, {
      started: "2026-09-25T09:10:00.000Z", model: "claude-sonnet-5", effort: "high", road: "claude", rows: 4, batchSize: 2,
      topUp: "false", shares: { calibration: 0.15, test: 0 },
      gates: { "content-judge": { done: 2, sessionId: null, kept: 4, refused: {}, unreadable: 0, lostBatches: 0, tokens: noTokens } },
    });

    for (const [index, splits] of [["train", "calibration"], ["train", "test"]].entries()) {
      freezeBatch(gate, "content-judge", index, splits.map((split, at) => ({
        row: JSON.parse(judged(`content-judge:t${index}${at}`, split as DatasetSplit, 0.05)) as DatasetRow,
        language: "korean" as const,
      })));
    }

    return run;
  }

  test("adds the top-up's training and calibration rows, keeps the test the source's own, and counts the rarer answer over both", () => {
    const where = folder();

    splits(where, {
      train: [judged("content-judge:r1", "train", 0.95), judged("content-judge:r2", "train", 0.95)],
      calibration: [judged("content-judge:r3", "calibration", 0.95)],
      test: [judged("content-judge:r4", "test", 0.95), judged("content-judge:r5", "test", 0.05)],
    });

    const run = topUpRun();
    const source = toppedUp(folderSource(where), run);
    const to = join(folder(), "copy");
    const copy = source.copy("content-judge", to);

    expect(source.name).toBe(`${basename(where)}.${basename(run)}`);
    expect(source.counts()).toEqual([{ gate: "content-judge", rows: { train: 4, calibration: 2, test: 2 }, rarer: 4, series: "" }]);
    expect(typeof copy === "string" ? copy : copy.rows).toEqual({ train: 4, calibration: 2, test: 2 });
    expect(readFileSync(join(to, splitFiles.test), "utf8")).not.toContain("content-judge:t");
    expect(source.bars("content-judge")).toEqual({ floor: 0, rarer: 0 });
  });

  test("leaves a gate the top-up never wrote as the source has it", () => {
    const where = folder();

    splits(where, { train: [row("a", "a1", "train")], calibration: [row("a", "a2", "calibration")], test: [row("a", "a3", "test")] });

    expect(toppedUp(folderSource(where), topUpRun()).counts()).toEqual([
      { gate: "a", rows: { train: 1, calibration: 1, test: 1 }, rarer: 0, series: "" },
    ]);
  });
});

describe("sourceOf", () => {
  test("knows the three kinds and refuses anything else", () => {
    expect(typeof sourceOf("reference:ref-1")).toBe("object");
    expect(typeof sourceOf("judging:real-1")).toBe("object");
    expect(typeof sourceOf("folder:/tmp/x")).toBe("object");
    expect(sourceOf("elsewhere:x")).toContain("가운데 하나가 아니에요");
    expect(sourceOf("reference:")).toContain("가운데 하나가 아니에요");
  });
});
