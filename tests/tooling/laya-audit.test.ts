import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { scratchDir } from "./scratch";

import {
  auditFloors,
  auditFrozen,
  auditGate,
  auditLines,
  freshSeed,
  minorityRows,
  readFrozen,
  sampleOf,
  seededRandom,
} from "../../training/tooling/src/laya-audit";
import { datasetRowOf, synthesisFor } from "../../training/tooling/src/laya-synth";
import { splitFiles } from "../../training/tooling/src/laya-frozen";
import { languageFile, metaFile } from "../../training/tooling/src/laya-synth-run";

import type { AuditRow } from "../../training/tooling/src/laya-audit";
import type { DatasetSplit } from "../../training/tooling/src/laya-dataset";
import type { GateSynthesis, LanguageBucket, SynthRow } from "../../training/tooling/src/laya-synth";
import { useToolingSettings } from "./settings";

useToolingSettings();

// Asked for at the one door, which registers its removal as it hands it over.
function scratch(): string {
  return scratchDir("bmo-laya-audit-");
}

function gate(name: string): GateSynthesis {
  const found = synthesisFor(name);

  if (found === null) {
    throw new Error(`no gate ${name}`);
  }

  return found;
}

const folds = gate("output-format");
const classifier = gate("knowledge-classifier");
const replies = gate("reply-wanted");
const shares = { calibration: 0.15, test: 0.15 };

function korean(tag: string): string {
  return `\uB77C\uC6B0\uD130 \uC124\uC815\uC744 \uC8FC\uB9D0 \uC804\uC5D0 \uBC31\uC5C5\uD574 \uB450\uB824\uACE0 \uD569\uB2C8\uB2E4. \uD45C\uC2DD ${tag}`;
}

function english(tag: string): string {
  return `I want to back up the router settings before the weekend. marker ${tag}`;
}

// An output gate's row over a message whose opening and closing are the text given, folded or not.
function foldRow(text: string, folded: boolean): SynthRow {
  const noul = folded ? 0.9 : 0.1;

  return {
    state: { ...(folds.example.state as Record<string, unknown>), head: text, tail: text },
    questions: JSON.parse(JSON.stringify(folds.example.questions)) as SynthRow["questions"],
    gold: {
      fold: {
        type: "noul",
        label: folded ? "true" : "false",
        noul,
        probabilities: { true: noul, false: 1 - noul },
      },
    },
  };
}

// A frozen folder written by hand, so a test can put exactly the flaw it means to measure into it.
function freeze(folder: string, written: readonly { spec: GateSynthesis; row: SynthRow; language?: LanguageBucket; split?: DatasetSplit }[]): void {
  const bySplit: Record<DatasetSplit, string[]> = { train: [], calibration: [], test: [] };
  const sidecar: string[] = [];

  for (const one of written) {
    const row = datasetRowOf(one.spec, one.row, shares);
    const split = one.split ?? row.split;

    bySplit[split].push(JSON.stringify({ ...row, split }));
    sidecar.push(JSON.stringify({ id: row.id, language: one.language ?? "korean" }));
  }

  for (const [split, name] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
    writeFileSync(join(folder, name), bySplit[split].map((line) => `${line}\n`).join(""));
  }

  writeFileSync(join(folder, languageFile), sidecar.map((line) => `${line}\n`).join(""));
}

function auditOne(folder: string, gateName: string, sample = 0, seed = "s") {
  return auditFrozen({ folder, sample, seed, gates: [gateName] }).gates[0]!;
}

describe("drawing a sample", () => {
  test("the same seed draws the same rows", () => {
    const items = Array.from({ length: 50 }, (_, index) => index);

    expect(sampleOf(items, 10, "seed-a")).toEqual(sampleOf(items, 10, "seed-a"));
  });

  test("a different seed draws different rows", () => {
    const items = Array.from({ length: 50 }, (_, index) => index);

    expect(sampleOf(items, 10, "seed-a")).not.toEqual(sampleOf(items, 10, "seed-b"));
  });

  test("it draws without replacement", () => {
    const drawn = sampleOf(Array.from({ length: 30 }, (_, index) => index), 12, "s");

    expect(new Set(drawn).size).toBe(12);
  });

  test("asking for more than there is takes everything", () => {
    expect(sampleOf([1, 2, 3], 99, "s")).toHaveLength(3);
  });

  test("asking for none takes everything", () => {
    expect(sampleOf([1, 2, 3], 0, "s")).toHaveLength(3);
  });

  test("the roll stays inside zero and one", () => {
    const roll = seededRandom("seed");

    for (let index = 0; index < 200; index += 1) {
      const value = roll();

      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("a fresh seed is made when none was given", () => {
    expect(freshSeed(1_700_000_000_000)).not.toBe(freshSeed(1_700_000_000_001));
  });
});

describe("reading a frozen folder", () => {
  test("it reads every split and attaches each row's language from the sidecar", () => {
    const folder = scratch();

    freeze(folder, [
      { spec: folds, row: foldRow(korean("a"), false), split: "train", language: "korean" },
      { spec: folds, row: foldRow(english("b"), false), split: "test", language: "english" },
    ]);

    const { rows, broken } = readFrozen(folder);

    expect(broken).toBe(0);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((one) => one.language))).toEqual(new Set(["korean", "english"]));
  });

  test("a line that is not a row at all is counted, not thrown away", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false), split: "train" }]);
    writeFileSync(join(folder, splitFiles.train), "\uC774\uAC74 JSON\uC774 \uC544\uB2D9\uB2C8\uB2E4\n{\"nope\":1}\n");

    expect(readFrozen(folder).broken).toBe(2);
  });

  test("a folder with no sidecar still reads, with no language on its rows", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false), split: "train" }]);
    rmSync(join(folder, languageFile));

    expect(readFrozen(folder).rows[0]!.language).toBeNull();
  });
});

describe("the conformance figure", () => {
  test("a folder of good rows is wholly conforming", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 20 }, (_, index) => ({
      spec: folds,
      row: foldRow(korean(String(index)), index % 2 === 0),
    })));

    const audit = auditOne(folder, "output-format");

    expect(audit.conformance).toBe(1);
    expect(audit.refused).toEqual({});
  });

  test("a row whose gold does not name its question's answers is refused and named", () => {
    const folder = scratch();
    const wrong = foldRow(korean("bad"), false);

    wrong.gold.fold = { type: "choice", label: "nope", probabilities: { nope: 1 } };

    freeze(folder, [
      { spec: folds, row: foldRow(korean("good"), false) },
      { spec: folds, row: wrong },
    ]);

    const audit = auditOne(folder, "output-format");

    expect(audit.conformance).toBe(0.5);
    expect(audit.refused["bad-answers"]).toBe(1);
  });

  test("a row whose questions do not ask what the gate asks is refused", () => {
    const folder = scratch();
    const wrong = foldRow(korean("bad"), false);

    wrong.questions.fold = { type: "noul", instructions: "\uC774 \uAE00\uC740 \uC704\uD5D8\uD55C\uAC00?" };

    freeze(folder, [{ spec: folds, row: wrong }]);

    expect(auditOne(folder, "output-format").refused["wrong-instructions"]).toBe(1);
  });

  test("the share that is wrong is the share that is not right", () => {
    const folder = scratch();
    const wrong = foldRow(korean("bad"), false);

    wrong.gold = {};

    freeze(folder, [
      { spec: folds, row: foldRow(korean("a"), false) },
      { spec: folds, row: foldRow(korean("b"), true) },
      { spec: folds, row: foldRow(korean("c"), false) },
      { spec: folds, row: wrong },
    ]);

    const audit = auditOne(folder, "output-format");

    expect(audit.conformance).toBe(0.75);
    expect(audit.conforming).toBe(3);
  });
});

describe("the broken-format figure", () => {
  test("a row whose three parts cannot be read is counted unreadable and judged on nothing", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false), split: "train" }]);
    writeFileSync(
      join(folder, splitFiles.train),
      `${JSON.stringify({ id: "output-format:x", gate: "output-format", split: "train", state: "{{{", questions: "{}", gold: "{}" })}\n`,
    );

    const audit = auditOne(folder, "output-format");

    expect(audit.unreadable).toBe(1);
    expect(audit.conformance).toBe(0);
  });
});

describe("the transcript figure", () => {
  test("a transcript in the gate's own shape is not counted broken", () => {
    const folder = scratch();

    freeze(folder, [{ spec: replies, row: replies.example }]);

    const audit = auditOne(folder, "reply-wanted");

    expect(audit.transcriptBroken).toBe(0);
    expect(audit.conformance).toBe(1);
  });

  test("a transcript in another gate's shape is counted on its own as well as refused", () => {
    const folder = scratch();
    const wrong = JSON.parse(JSON.stringify(replies.example)) as SynthRow;

    (wrong.state as { message: string }).message = "\uBBFC\uC11C (id 4471902): \uC774 \uC904\uC740 \uD3C9\uBC94\uD55C \uBAA8\uC591\uC785\uB2C8\uB2E4";

    freeze(folder, [
      { spec: replies, row: replies.example },
      { spec: replies, row: wrong },
    ]);

    const audit = auditOne(folder, "reply-wanted");

    expect(audit.transcriptBroken).toBe(1);
    expect(audit.transcriptShare).toBe(0.5);
    expect(audit.refused["wrong-transcript"]).toBe(1);
  });
});

describe("the balance figure", () => {
  test("an even gate reaches its target and drifts by nothing", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 20 }, (_, index) => ({
      spec: folds,
      row: foldRow(korean(String(index)), index % 2 === 0),
    })));

    const audit = auditOne(folder, "output-format");

    expect(audit.balance).toEqual({ true: 0.5, false: 0.5 });
    expect(audit.balanceTarget).toEqual({ true: 0.5, false: 0.5 });
    expect(audit.balanceDrift).toBe(0);
  });

  test("a gate answering one way only drifts by half", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 10 }, (_, index) => ({
      spec: folds,
      row: foldRow(korean(String(index)), false),
    })));

    const audit = auditOne(folder, "output-format");

    expect(audit.balance).toEqual({ false: 1 });
    expect(audit.balanceDrift).toBe(0.5);
  });

});

describe("the language figure", () => {
  test("the split is read off the rows and set beside the gate's own ratio", () => {
    const folder = scratch();

    freeze(folder, [
      ...Array.from({ length: 4 }, (_, index) => ({ spec: folds, row: foldRow(korean(String(index)), false), language: "korean" as const })),
      ...Array.from({ length: 4 }, (_, index) => ({ spec: folds, row: foldRow(english(String(index)), false), language: "english" as const })),
    ]);

    const audit = auditOne(folder, "output-format");

    expect(audit.language.korean).toBe(0.5);
    expect(audit.language.english).toBe(0.5);
    expect(audit.language.mixed).toBe(0);
    expect(audit.languageTarget).toEqual(folds.language);
  });

  test("the drift is the furthest any one language stands from its target", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 10 }, (_, index) => ({
      spec: folds,
      row: foldRow(korean(String(index)), false),
      language: "korean" as const,
    })));

    // The output gate is drawn to 65% Korean, and this folder is all of it.
    expect(auditOne(folder, "output-format").languageDrift).toBeCloseTo(0.35, 5);
  });

  test("a sidecar naming a language the row does not read as is counted", () => {
    const folder = scratch();

    freeze(folder, [
      { spec: folds, row: foldRow(korean("a"), false), language: "english" },
      { spec: folds, row: foldRow(korean("b"), false), language: "korean" },
    ]);

    expect(auditOne(folder, "output-format").sidecarMismatch).toBe(1);
  });
});

describe("the floors", () => {
  test("a small folder does not meet them and says by how much", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 6 }, (_, index) => ({
      spec: folds,
      row: foldRow(korean(String(index)), index % 2 === 0),
      split: (index < 4 ? "train" : "test") as DatasetSplit,
    })));

    const audit = auditOne(folder, "output-format");

    expect(audit.floors.met).toBe(false);
    expect(audit.floors.train).toBe(4);
    expect(audit.floors.evaluation).toBe(2);
    expect(auditFloors.train).toBe(4_000);
  });

  test("the minority count of a yes/no gate is the rarer answer's rows", () => {
    const rows: AuditRow[] = Array.from({ length: 10 }, (_, index) => ({
      row: { id: `x${index}`, gate: "output-format", split: "train", state: "", questions: "", gold: "" },
      language: "korean",
      read: foldRow(korean(String(index)), index < 3),
    }));

    expect(minorityRows(folds, rows)).toBe(3);
  });

  test("the floors are read off every row and not off the sample", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 30 }, (_, index) => ({
      spec: folds,
      row: foldRow(korean(String(index)), index % 2 === 0),
      split: "train" as DatasetSplit,
    })));

    const audit = auditOne(folder, "output-format", 5);

    expect(audit.sampled).toBe(5);
    expect(audit.rows).toBe(30);
    expect(audit.floors.train).toBe(30);
  });
});

describe("a gate this project does not know", () => {
  test("is reported rather than crashing the audit", () => {
    const folder = scratch();

    writeFileSync(
      join(folder, splitFiles.train),
      `${JSON.stringify({ id: "ghost:1", gate: "ghost", split: "train", state: '"\uC548\uB155"', questions: "{}", gold: "{}" })}\n`,
    );

    const audit = auditFrozen({ folder, sample: 0, seed: "s" }).gates[0]!;

    expect(audit.known).toBe(false);
    expect(audit.rows).toBe(1);
    expect(auditLines({ folder, seed: "s", sample: 0, gates: [audit] }).join("\n")).toContain("a gate with no specification");
  });
});

describe("what it prints", () => {
  test("the seed stands in the report so the sample can be drawn again", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false) }]);

    expect(auditLines(auditFrozen({ folder, sample: 10, seed: "zz9" })).join("\n")).toContain("seed zz9");
  });

  test("every figure it counts is in the lines it prints", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 8 }, (_, index) => ({
      spec: folds,
      row: foldRow(korean(String(index)), index % 2 === 0),
    })));

    const said = auditLines(auditFrozen({ folder, sample: 0, seed: "s" })).join("\n");

    expect(said).toContain("output-format");
    expect(said).toContain("keep the specification");
    expect(said).toContain("off ");
    expect(said).toContain("rows of the wrong transcript shape");
    expect(said).toContain("answer balance");
    expect(said).toContain("language");
    expect(said).toContain("floors");
  });

  test("an empty folder says so rather than printing an empty table", () => {
    const folder = scratch();

    freeze(folder, []);

    expect(auditLines(auditFrozen({ folder, sample: 0, seed: "s" })).join("\n")).toContain("No frozen rows.");
  });
});

describe("what the model wrote against what survived", () => {
  const meta = (gates: unknown[]) => JSON.stringify({ model: "claude-opus-5", gates });

  test("the repeats and the format breaks are shares of what was written", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{
      gate: "output-format",
      kept: 80,
      unreadable: 4,
      duplicates: 3,
      refused: { "wrong-transcript": 6, "wrong-language": 10 },
    }]));

    const made = auditOne(folder, "output-format").generation!;

    expect(made.written).toBe(100);
    expect(made.duplicates).toBe(3);
    expect(made.duplicateShare).toBe(0.03);
    // Six transcripts in the wrong shape and four rows that were not rows at all; a wrong language
    // is not a broken format.
    expect(made.formatBreakShare).toBe(0.1);
  });

  test("the share that survived the generator is read off the run's own meta", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{ gate: "output-format", kept: 35, unreadable: 0, refused: { "bad-answers": 5 } }]));

    const made = auditOne(folder, "output-format").generation!;

    expect(made.written).toBe(40);
    expect(made.kept).toBe(35);
    expect(made.keptShare).toBe(0.875);
    expect(made.refused["bad-answers"]).toBe(5);
  });

  test("rows the generator could not read at all count against what was written", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{ gate: "output-format", kept: 6, unreadable: 2, refused: { "too-large": 2 } }]));

    const made = auditOne(folder, "output-format").generation!;

    expect(made.written).toBe(10);
    expect(made.keptShare).toBe(0.6);
  });

  test("a folder carried in from somewhere else has no such figure and says so", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false) }]);

    const audit = auditFrozen({ folder, sample: 0, seed: "s" });

    expect(audit.gates[0]!.generation).toBeNull();
    expect(auditLines(audit).join("\n")).toContain("holds no run record, so it cannot be known");
  });

  test("a meta that names no such gate gives no figure rather than a zero", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{ gate: "someone-else", kept: 1, refused: {} }]));

    expect(auditOne(folder, "output-format").generation).toBeNull();
  });

  test("a meta that cannot be read gives no figure rather than throwing", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), "\uC774\uAC74 JSON\uC774 \uC544\uB2D9\uB2C8\uB2E4");

    expect(auditOne(folder, "output-format").generation).toBeNull();
  });

  test("the share is printed beside the sample's own", () => {
    const folder = scratch();

    freeze(folder, [{ spec: folds, row: foldRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{ gate: "output-format", kept: 9, unreadable: 0, refused: { "wrong-language": 1 } }]));

    const said = auditLines(auditFrozen({ folder, sample: 0, seed: "s" })).join("\n");

    expect(said).toContain("of 10 rows the model wrote, kept 9 (90.0%)");
    expect(said).toContain("wrong-language 1");
  });
});

describe("auditing one gate at a time", () => {
  test("only the gates asked for are reported", () => {
    const folder = scratch();

    freeze(folder, [
      { spec: folds, row: foldRow(korean("a"), false) },
      { spec: classifier, row: classifier.example },
    ]);

    expect(auditFrozen({ folder, sample: 0, seed: "s" }).gates.map((one) => one.gate)).toEqual(["knowledge-classifier", "output-format"]);
    expect(auditFrozen({ folder, sample: 0, seed: "s", gates: ["output-format"] }).gates.map((one) => one.gate)).toEqual(["output-format"]);
  });

  test("one gate's rows are never counted against another's", () => {
    const folder = scratch();

    freeze(folder, [
      { spec: folds, row: foldRow(korean("a"), false) },
      { spec: folds, row: foldRow(korean("b"), true) },
      { spec: classifier, row: classifier.example },
    ]);

    const { rows } = readFrozen(folder);

    expect(auditGate("output-format", rows, 0, "s").rows).toBe(2);
    expect(auditGate("knowledge-classifier", rows, 0, "s").rows).toBe(1);
  });
});
