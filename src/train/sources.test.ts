import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitFiles } from "../laya-frozen";
import { scratchDir } from "../scratch";
import { folderSource, referenceSource, sourceOf } from "./sources";

import type { DatasetSplit } from "../laya-dataset";

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

describe("sourceOf", () => {
  test("knows the three kinds and refuses anything else", () => {
    expect(typeof sourceOf("reference:ref-1")).toBe("object");
    expect(typeof sourceOf("judging:real-1")).toBe("object");
    expect(typeof sourceOf("folder:/tmp/x")).toBe("object");
    expect(sourceOf("elsewhere:x")).toContain("가운데 하나가 아니에요");
    expect(sourceOf("reference:")).toContain("가운데 하나가 아니에요");
  });
});
