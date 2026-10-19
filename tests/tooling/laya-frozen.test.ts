import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { scratchDir } from "./scratch";

import { frozenHere, overwriteFlag, refuseOverwrite, splitFiles, whatStands } from "../../training/tooling/src/laya-frozen";

// Asked for at the one door, which registers its removal as it hands it over.
function scratch(): string {
  return scratchDir("bmo-laya-frozen-");
}

describe("whether a folder already holds a frozen dataset", () => {
  test("an empty folder does not", () => {
    expect(frozenHere(scratch())).toBe(false);
  });

  test("a folder that does not exist does not", () => {
    expect(frozenHere(join(tmpdir(), "nothing-is-here-at-all"))).toBe(false);
  });

  test("any one of the three files is enough", () => {
    for (const name of Object.values(splitFiles)) {
      const folder = scratch();

      writeFileSync(join(folder, name), "");

      expect(frozenHere(folder)).toBe(true);
    }
  });

  test("a folder holding something else does not", () => {
    const folder = scratch();

    writeFileSync(join(folder, "notes.txt"), "\uc548\ub155");
    mkdirSync(join(folder, "batches"));

    expect(frozenHere(folder)).toBe(false);
  });
});

describe("what stands in a folder", () => {
  test("a file of rows is counted, so a dataset worth keeping is told from a stub", () => {
    const folder = scratch();

    writeFileSync(join(folder, splitFiles.train), '{"a":1}\n{"a":2}\n{"a":3}\n');

    expect(whatStands(folder)).toEqual(["train.jsonl (3 rows)"]);
  });

  test("an empty file is counted at nothing rather than left out", () => {
    const folder = scratch();

    writeFileSync(join(folder, splitFiles.test), "");

    expect(whatStands(folder)).toEqual(["test.jsonl (0 rows)"]);
  });

  test("a hidden file is not named, since it is nobody's dataset", () => {
    const folder = scratch();

    writeFileSync(join(folder, ".hidden-bookkeeping"), "x");
    writeFileSync(join(folder, splitFiles.train), '{"a":1}\n');

    expect(whatStands(folder)).toEqual(["train.jsonl (1 rows)"]);
  });

  test("everything else is named without a count", () => {
    const folder = scratch();

    writeFileSync(join(folder, "teacher.meta.json"), "{}");
    mkdirSync(join(folder, "batches"));

    expect(whatStands(folder)).toEqual(["batches", "teacher.meta.json"]);
  });

  test("it is in a settled order, so two refusals of the same folder read the same", () => {
    const folder = scratch();

    writeFileSync(join(folder, splitFiles.test), "");
    writeFileSync(join(folder, splitFiles.train), "");
    writeFileSync(join(folder, splitFiles.calibration), "");

    expect(whatStands(folder)).toEqual(["calibration.jsonl (0 rows)", "test.jsonl (0 rows)", "train.jsonl (0 rows)"]);
  });

  test("a folder that is not there stands empty rather than throwing", () => {
    expect(whatStands(join(tmpdir(), "nothing-is-here-at-all"))).toEqual([]);
  });
});

describe("the refusal", () => {
  test("an empty folder is not refused", () => {
    expect(refuseOverwrite(scratch(), false)).toBeNull();
  });

  test("a frozen folder is refused, and the refusal names it and what stands in it", () => {
    const folder = scratch();

    writeFileSync(join(folder, splitFiles.train), '{"a":1}\n{"a":2}\n');
    writeFileSync(join(folder, "teacher.meta.json"), "{}");

    const refusal = refuseOverwrite(folder, false)!;

    expect(refusal).toContain(folder);
    expect(refusal).toContain("train.jsonl (2 rows)");
    expect(refusal).toContain("teacher.meta.json");
  });

  test("the refusal names the flag that would allow it", () => {
    const folder = scratch();

    writeFileSync(join(folder, splitFiles.train), "");

    expect(refuseOverwrite(folder, false)).toContain(overwriteFlag);
  });

  test("saying outright that it is meant lets it through", () => {
    const folder = scratch();

    writeFileSync(join(folder, splitFiles.train), '{"a":1}\n');

    expect(refuseOverwrite(folder, true)).toBeNull();
  });

  test("a folder holding only a half-written run is not this refusal's to make", () => {
    const folder = scratch();

    mkdirSync(join(folder, "batches"));
    writeFileSync(join(folder, "progress.json"), "{}");

    expect(refuseOverwrite(folder, false)).toBeNull();
  });
});
