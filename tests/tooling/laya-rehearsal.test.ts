import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { datasetSplits } from "../../training/tooling/src/laya-dataset";
import { splitFiles } from "../../training/tooling/src/laya-frozen";
import {
  REHEARSAL_FIELD,
  buildRehearsal,
  isRehearsalRow,
  rehearsalFaults,
  rehearsalFolder,
  rehearsalGates,
  rehearsalLines,
  rehearsalMeta,
  rehearsalMetaFile,
  rehearsalRows,
  rowsUntilSplitsFill,
  variedGold,
  type RehearsalMeta,
} from "../../training/tooling/src/laya-rehearsal";
import { answersOf, datasetRowOf, gateSyntheses, languageOf, stateText, synthesisFor, validateSynthRow } from "../../training/tooling/src/laya-synth";
import { scratchDir } from "./scratch";
import { languageFile } from "../../training/tooling/src/laya-synth-run";

import type { DatasetSplit } from "../../training/tooling/src/laya-dataset";
import { useToolingSettings } from "./settings";

useToolingSettings();

const shares = { calibration: 0.2, test: 0.2 };

// One directory for the file, asked for at the one door that takes it away again, and a room of its
// own under it for each case.
const root = scratchDir("bmo-laya-rehearsal-");
let made = 0;

function folder(): string {
  made += 1;
  const where = join(root, `case-${made}`);

  mkdirSync(where, { recursive: true });

  return where;
}

function rowsIn(where: string, split: DatasetSplit): Array<Record<string, unknown>> {
  return readFileSync(join(where, splitFiles[split]), "utf8").split("\n")
    .filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the rows a rehearsal is made of", () => {
  test("every gate's rows answer that gate's own specification", () => {
    expect(rehearsalFaults(gateSyntheses(), 8, 713)).toEqual([]);
  });

  test("every gate is covered, not only the ones with a simple state", () => {
    expect(gateSyntheses().length).toBeGreaterThan(0);
    for (const gate of gateSyntheses()) {
      const rows = rehearsalRows(gate, 4, 713);

      expect(rows.length).toBe(4);
      for (const row of rows) {
        expect(validateSynthRow(gate, row, "korean").ok).toBe(true);
      }
    }
  });

  test("the same seed writes the same rows and another seed writes others", () => {
    const gate = synthesisFor("reply-wanted")!;

    expect(rehearsalRows(gate, 5, 713)).toEqual(rehearsalRows(gate, 5, 713));
    expect(rehearsalRows(gate, 5, 714)).not.toEqual(rehearsalRows(gate, 5, 713));
  });

  test("a row's own text is what varies, and every row is its own input", () => {
    const gate = synthesisFor("reply-wanted")!;
    const rows = rehearsalRows(gate, 12, 713);
    const ids = new Set(rows.map((row) => datasetRowOf(gate, row, shares).id));

    expect(ids.size).toBe(12);
  });

  test("the rows stay in the language the gate's data is drawn to", () => {
    for (const gate of gateSyntheses()) {
      for (const row of rehearsalRows(gate, 3, 713)) {
        expect(languageOf(stateText(gate, row.state))).toBe("korean");
      }
    }
  });

  test("every answer of every question is taught, so no gate is all one answer", () => {
    for (const gate of gateSyntheses()) {
      const seen = new Set<string>();

      for (const row of rehearsalRows(gate, 12, 713)) {
        for (const gold of Object.values(row.gold)) {
          seen.add(gold.label);
        }
      }
      for (const question of gate.questions) {
        for (const answer of answersOf(question)) {
          expect([...seen]).toContain(answer);
        }
      }
    }
  });

  test("a gold's probabilities come to one and its label is the likeliest answer", () => {
    for (const answers of [["true", "false"], ["universal", "personal", "room", "none"]]) {
      for (let turn = 0; turn < answers.length; turn += 1) {
        const type = answers.length === 2 ? "noul" : "choice";
        const gold = variedGold({ type, instructions: "x", criteria: answers } as never, answers, turn);
        const weights = Object.values(gold.probabilities);

        expect(Object.keys(gold.probabilities).sort()).toEqual([...answers].sort());
        expect(Math.abs(weights.reduce((sum, one) => sum + one, 0) - 1)).toBeLessThan(0.001);
        expect(gold.label).toBe(answers[turn]!);
        expect((gold.probabilities as Record<string, number>)[gold.label]).toBe(Math.max(...weights));
      }
    }
  });
});

describe("the three splits", () => {
  test("a gate's rows grow until every split holds what it owes", () => {
    const gate = synthesisFor("output-format")!;
    const filled = rowsUntilSplitsFill(gate, 8, 2, 713, shares);

    expect(typeof filled).not.toBe("string");
    if (typeof filled === "string") {
      return;
    }
    for (const split of datasetSplits) {
      expect(filled.splits[split]).toBeGreaterThanOrEqual(2);
    }
    expect(filled.rows.length).toBeGreaterThanOrEqual(8);
  });

  test("no input sits in two splits", () => {
    const where = folder();

    try {
      const built = buildRehearsal({ folder: where, rows: 8, shares });

      expect(typeof built).not.toBe("string");

      const ids = datasetSplits.flatMap((split) => rowsIn(where, split).map((row) => row.id as string));

      expect(new Set(ids).size).toBe(ids.length);
      for (const split of datasetSplits) {
        expect(rowsIn(where, split).every((row) => row.split === split)).toBe(true);
      }
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });

  test("every split of every gate holds rows, since an empty one cannot be calibrated or measured on", () => {
    const where = folder();

    try {
      const built = buildRehearsal({ folder: where, rows: 8, shares, minPerSplit: 2 }) as RehearsalMeta;

      for (const gate of built.gates) {
        for (const split of datasetSplits) {
          expect(gate.splits[split]).toBeGreaterThanOrEqual(2);
        }
      }
      expect(built.gates.length).toBe(gateSyntheses().length);
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });
});

describe("the mark a rehearsal row carries", () => {
  test("every row written carries it", () => {
    const where = folder();

    try {
      buildRehearsal({ folder: where, rows: 6, shares });

      for (const split of datasetSplits) {
        const rows = rowsIn(where, split);

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row[REHEARSAL_FIELD] === true)).toBe(true);
        expect(rows.every((row) => isRehearsalRow(row))).toBe(true);
      }
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });

  test("a row of real data carries none", () => {
    expect(isRehearsalRow({ id: "x", gate: "output-format", split: "train" })).toBe(false);
    expect(isRehearsalRow({ rehearsal: "yes" })).toBe(false);
    expect(isRehearsalRow(null)).toBe(false);
  });

  test("the folder says what it is, and a folder of marked rows says so without the file", () => {
    const where = folder();

    try {
      buildRehearsal({ folder: where, rows: 6, shares });

      expect(rehearsalMeta(where)?.kind).toBe("laya-rehearsal");
      expect(rehearsalFolder(where)).toBe(true);

      rmSync(join(where, rehearsalMetaFile));

      expect(rehearsalMeta(where)).toBeNull();
      expect(rehearsalFolder(where)).toBe(true);
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });

  test("a folder of real rows is not a rehearsal one", () => {
    const where = folder();

    try {
      writeFileSync(join(where, splitFiles.train), `${JSON.stringify({ id: "x", gate: "output-format", split: "train" })}\n`);

      expect(rehearsalFolder(where)).toBe(false);
      expect(rehearsalMeta(where)).toBeNull();
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });

  test("a meta of another kind is not read as ours", () => {
    const where = folder();

    try {
      writeFileSync(join(where, rehearsalMetaFile), JSON.stringify({ kind: "synth", gates: [] }));

      expect(rehearsalMeta(where)).toBeNull();
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });
});

describe("what the folder holds", () => {
  test("the three splits, the language beside each row, and the meta", () => {
    const where = folder();

    try {
      const built = buildRehearsal({ folder: where, rows: 6, seed: 99, shares }) as RehearsalMeta;
      const languages = readFileSync(join(where, languageFile), "utf8").split("\n").filter((line) => line.trim() !== "");
      const rows = datasetSplits.flatMap((split) => rowsIn(where, split));

      expect(languages.length).toBe(rows.length);
      expect(new Set(languages.map((line) => (JSON.parse(line) as { language: string }).language))).toEqual(new Set(["korean"]));
      expect(built.seed).toBe(99);
      expect(built.rowsAsked).toBe(6);
      expect(built.shares).toEqual(shares);
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });

  test("the same seed writes the same folder twice over", () => {
    const first = folder();
    const second = folder();

    try {
      buildRehearsal({ folder: first, rows: 6, seed: 5, shares });
      buildRehearsal({ folder: second, rows: 6, seed: 5, shares });

      for (const split of datasetSplits) {
        expect(readFileSync(join(first, splitFiles[split]), "utf8")).toBe(readFileSync(join(second, splitFiles[split]), "utf8"));
      }
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("one gate alone can be written", () => {
    const where = folder();

    try {
      const built = buildRehearsal({ folder: where, gates: ["reply-wanted"], rows: 6, shares }) as RehearsalMeta;

      expect(built.gates.map((one) => one.gate)).toEqual(["reply-wanted"]);
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });

  test("a name that is not a gate's stops the writing and says the names that are", () => {
    const where = folder();

    try {
      const built = buildRehearsal({ folder: where, gates: ["reply-wanted", "made-up"], rows: 6, shares });

      expect(typeof built).toBe("string");
      expect(built as string).toContain("made-up");
      expect(built as string).toContain("reply-wanted");
      expect(rehearsalGates(["made-up"])).toBe("made-up");
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });

  test("what is printed says the counts and that the figures are not evidence", () => {
    const where = folder();

    try {
      const built = buildRehearsal({ folder: where, rows: 6, shares }) as RehearsalMeta;
      const lines = rehearsalLines(built).join("\n");

      expect(lines).toContain("reply-wanted");
      expect(lines).toContain("A figure measured on this data says only whether the machinery runs, never whether a gate is any good.");
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });
});
