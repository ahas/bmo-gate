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
} from "./laya-audit";
import { datasetRowOf, synthesisFor } from "./laya-synth";
import { splitFiles } from "./laya-frozen";
import { languageFile, metaFile } from "./laya-synth-run";

import type { AuditRow } from "./laya-audit";
import type { DatasetSplit } from "./laya-dataset";
import type { GateSynthesis, LanguageBucket, SynthRow } from "./laya-synth";

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

const sanitizer = gate("sanitizer");
const classifier = gate("system-documents");
const shares = { calibration: 0.15, test: 0.15 };

function korean(tag: string): string {
  return `라우터 설정을 주말 전에 백업해 두려고 합니다. 표식 ${tag}`;
}

function english(tag: string): string {
  return `I want to back up the router settings before the weekend. marker ${tag}`;
}

function sanitizerRow(state: string, intrusion: boolean): SynthRow {
  const noul = intrusion ? 0.9 : 0.1;

  return {
    state,
    questions: JSON.parse(JSON.stringify(sanitizer.example.questions)) as SynthRow["questions"],
    gold: {
      harmful: {
        type: "noul",
        label: intrusion ? "true" : "false",
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
      { spec: sanitizer, row: sanitizerRow(korean("a"), false), split: "train", language: "korean" },
      { spec: sanitizer, row: sanitizerRow(english("b"), false), split: "test", language: "english" },
    ]);

    const { rows, broken } = readFrozen(folder);

    expect(broken).toBe(0);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((one) => one.language))).toEqual(new Set(["korean", "english"]));
  });

  test("a line that is not a row at all is counted, not thrown away", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false), split: "train" }]);
    writeFileSync(join(folder, splitFiles.train), "이건 JSON이 아닙니다\n{\"nope\":1}\n");

    expect(readFrozen(folder).broken).toBe(2);
  });

  test("a folder with no sidecar still reads, with no language on its rows", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false), split: "train" }]);
    rmSync(join(folder, languageFile));

    expect(readFrozen(folder).rows[0]!.language).toBeNull();
  });
});

describe("the conformance figure", () => {
  test("a folder of good rows is wholly conforming", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 20 }, (_, index) => ({
      spec: sanitizer,
      row: sanitizerRow(korean(String(index)), index % 2 === 0),
    })));

    const audit = auditOne(folder, "sanitizer");

    expect(audit.conformance).toBe(1);
    expect(audit.refused).toEqual({});
  });

  test("a row whose gold does not name its question's answers is refused and named", () => {
    const folder = scratch();
    const wrong = sanitizerRow(korean("bad"), false);

    wrong.gold.harmful = { type: "choice", label: "nope", probabilities: { nope: 1 } };

    freeze(folder, [
      { spec: sanitizer, row: sanitizerRow(korean("good"), false) },
      { spec: sanitizer, row: wrong },
    ]);

    const audit = auditOne(folder, "sanitizer");

    expect(audit.conformance).toBe(0.5);
    expect(audit.refused["bad-answers"]).toBe(1);
  });

  test("a row whose questions do not ask what the gate asks is refused", () => {
    const folder = scratch();
    const wrong = sanitizerRow(korean("bad"), false);

    wrong.questions.harmful = { type: "noul", instructions: "이 글은 위험한가?" };

    freeze(folder, [{ spec: sanitizer, row: wrong }]);

    expect(auditOne(folder, "sanitizer").refused["wrong-instructions"]).toBe(1);
  });

  test("the share that is wrong is the share that is not right", () => {
    const folder = scratch();
    const wrong = sanitizerRow(korean("bad"), false);

    wrong.gold = {};

    freeze(folder, [
      { spec: sanitizer, row: sanitizerRow(korean("a"), false) },
      { spec: sanitizer, row: sanitizerRow(korean("b"), true) },
      { spec: sanitizer, row: sanitizerRow(korean("c"), false) },
      { spec: sanitizer, row: wrong },
    ]);

    const audit = auditOne(folder, "sanitizer");

    expect(audit.conformance).toBe(0.75);
    expect(audit.conforming).toBe(3);
  });
});

describe("the broken-format figure", () => {
  test("a row whose three parts cannot be read is counted unreadable and judged on nothing", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false), split: "train" }]);
    writeFileSync(
      join(folder, splitFiles.train),
      `${JSON.stringify({ id: "sanitizer:x", gate: "sanitizer", split: "train", state: "{{{", questions: "{}", gold: "{}" })}\n`,
    );

    const audit = auditOne(folder, "sanitizer");

    expect(audit.unreadable).toBe(1);
    expect(audit.conformance).toBe(0);
  });
});

describe("the transcript figure", () => {
  test("a transcript in the gate's own shape is not counted broken", () => {
    const folder = scratch();

    freeze(folder, [{ spec: classifier, row: classifier.example }]);

    const audit = auditOne(folder, "system-documents");

    expect(audit.transcriptBroken).toBe(0);
    expect(audit.conformance).toBe(1);
  });

  test("a transcript in another gate's shape is counted on its own as well as refused", () => {
    const folder = scratch();
    const wrong = JSON.parse(JSON.stringify(classifier.example)) as SynthRow;

    wrong.state = "[2026-01-01T00:00:00.000Z] #1 민서 (id 4471902): 이 줄은 방 모양입니다";

    freeze(folder, [
      { spec: classifier, row: classifier.example },
      { spec: classifier, row: wrong },
    ]);

    const audit = auditOne(folder, "system-documents");

    expect(audit.transcriptBroken).toBe(1);
    expect(audit.transcriptShare).toBe(0.5);
    expect(audit.refused["wrong-transcript"]).toBe(1);
  });
});

describe("the balance figure", () => {
  test("an even gate reaches its target and drifts by nothing", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 20 }, (_, index) => ({
      spec: sanitizer,
      row: sanitizerRow(korean(String(index)), index % 2 === 0),
    })));

    const audit = auditOne(folder, "sanitizer");

    expect(audit.balance).toEqual({ true: 0.5, false: 0.5 });
    expect(audit.balanceTarget).toEqual({ true: 0.5, false: 0.5 });
    expect(audit.balanceDrift).toBe(0);
  });

  test("a gate answering one way only drifts by half", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 10 }, (_, index) => ({
      spec: sanitizer,
      row: sanitizerRow(korean(String(index)), false),
    })));

    const audit = auditOne(folder, "sanitizer");

    expect(audit.balance).toEqual({ false: 1 });
    expect(audit.balanceDrift).toBe(0.5);
  });

  test("a gate asking one question a candidate counts its balance over questions", () => {
    const folder = scratch();

    freeze(folder, [{ spec: classifier, row: classifier.example }]);

    const audit = auditOne(folder, "system-documents");
    const asked = Object.keys(classifier.example.questions).length;

    expect(Object.values(audit.balance).reduce((sum, one) => sum + one, 0)).toBeCloseTo(1, 5);
    expect(asked).toBeGreaterThan(1);
  });
});

describe("the language figure", () => {
  test("the split is read off the rows and set beside the gate's own ratio", () => {
    const folder = scratch();

    freeze(folder, [
      ...Array.from({ length: 4 }, (_, index) => ({ spec: sanitizer, row: sanitizerRow(korean(String(index)), false), language: "korean" as const })),
      ...Array.from({ length: 4 }, (_, index) => ({ spec: sanitizer, row: sanitizerRow(english(String(index)), false), language: "english" as const })),
    ]);

    const audit = auditOne(folder, "sanitizer");

    expect(audit.language.korean).toBe(0.5);
    expect(audit.language.english).toBe(0.5);
    expect(audit.language.mixed).toBe(0);
    expect(audit.languageTarget).toEqual(sanitizer.language);
  });

  test("the drift is the furthest any one language stands from its target", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 10 }, (_, index) => ({
      spec: sanitizer,
      row: sanitizerRow(korean(String(index)), false),
      language: "korean" as const,
    })));

    // The sanitiser is drawn to 40% Korean, and this folder is all of it.
    expect(auditOne(folder, "sanitizer").languageDrift).toBeCloseTo(0.6, 5);
  });

  test("a sidecar naming a language the row does not read as is counted", () => {
    const folder = scratch();

    freeze(folder, [
      { spec: sanitizer, row: sanitizerRow(korean("a"), false), language: "english" },
      { spec: sanitizer, row: sanitizerRow(korean("b"), false), language: "korean" },
    ]);

    expect(auditOne(folder, "sanitizer").sidecarMismatch).toBe(1);
  });
});

describe("the floors", () => {
  test("a small folder does not meet them and says by how much", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 6 }, (_, index) => ({
      spec: sanitizer,
      row: sanitizerRow(korean(String(index)), index % 2 === 0),
      split: (index < 4 ? "train" : "test") as DatasetSplit,
    })));

    const audit = auditOne(folder, "sanitizer");

    expect(audit.floors.met).toBe(false);
    expect(audit.floors.train).toBe(4);
    expect(audit.floors.evaluation).toBe(2);
    expect(auditFloors.train).toBe(4_000);
  });

  test("the minority count of a yes/no gate is the rarer answer's rows", () => {
    const rows: AuditRow[] = Array.from({ length: 10 }, (_, index) => ({
      row: { id: `x${index}`, gate: "sanitizer", split: "train", state: "", questions: "", gold: "" },
      language: "korean",
      read: sanitizerRow(korean(String(index)), index < 3),
    }));

    expect(minorityRows(sanitizer, rows)).toBe(3);
  });

  test("the minority count of a per-candidate gate weighs rows that chose something against rows that chose nothing", () => {
    const none = JSON.parse(JSON.stringify(classifier.example)) as SynthRow;

    for (const key of Object.keys(none.gold)) {
      none.gold[key] = { type: "noul", label: "false", noul: 0.05, probabilities: { true: 0.05, false: 0.95 } };
    }

    const rows: AuditRow[] = [
      { row: { id: "a", gate: "system-documents", split: "train", state: "", questions: "", gold: "" }, language: "korean", read: classifier.example },
      { row: { id: "b", gate: "system-documents", split: "train", state: "", questions: "", gold: "" }, language: "korean", read: none },
      { row: { id: "c", gate: "system-documents", split: "train", state: "", questions: "", gold: "" }, language: "korean", read: none },
    ];

    expect(minorityRows(classifier, rows)).toBe(1);
  });

  test("the floors are read off every row and not off the sample", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 30 }, (_, index) => ({
      spec: sanitizer,
      row: sanitizerRow(korean(String(index)), index % 2 === 0),
      split: "train" as DatasetSplit,
    })));

    const audit = auditOne(folder, "sanitizer", 5);

    expect(audit.sampled).toBe(5);
    expect(audit.rows).toBe(30);
    expect(audit.floors.train).toBe(30);
  });
});

describe("a gate this repository does not know", () => {
  test("is reported rather than crashing the audit", () => {
    const folder = scratch();

    writeFileSync(
      join(folder, splitFiles.train),
      `${JSON.stringify({ id: "ghost:1", gate: "ghost", split: "train", state: '"안녕"', questions: "{}", gold: "{}" })}\n`,
    );

    const audit = auditFrozen({ folder, sample: 0, seed: "s" }).gates[0]!;

    expect(audit.known).toBe(false);
    expect(audit.rows).toBe(1);
    expect(auditLines({ folder, seed: "s", sample: 0, gates: [audit] }).join("\n")).toContain("규격이 없는 게이트");
  });
});

describe("what it prints", () => {
  test("the seed stands in the report so the sample can be drawn again", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false) }]);

    expect(auditLines(auditFrozen({ folder, sample: 10, seed: "zz9" })).join("\n")).toContain("씨앗 zz9");
  });

  test("every figure it counts is in the lines it prints", () => {
    const folder = scratch();

    freeze(folder, Array.from({ length: 8 }, (_, index) => ({
      spec: sanitizer,
      row: sanitizerRow(korean(String(index)), index % 2 === 0),
    })));

    const said = auditLines(auditFrozen({ folder, sample: 0, seed: "s" })).join("\n");

    expect(said).toContain("sanitizer");
    expect(said).toContain("규격에 맞는 것");
    expect(said).toContain("어긋난 비율");
    expect(said).toContain("전사 모양이 틀린 행");
    expect(said).toContain("답 비율");
    expect(said).toContain("언어");
    expect(said).toContain("바닥");
  });

  test("an empty folder says so rather than printing an empty table", () => {
    const folder = scratch();

    freeze(folder, []);

    expect(auditLines(auditFrozen({ folder, sample: 0, seed: "s" })).join("\n")).toContain("굳은 행이 없습니다");
  });
});

describe("what the model wrote against what survived", () => {
  const meta = (gates: unknown[]) => JSON.stringify({ model: "claude-opus-5", gates });

  test("the repeats and the format breaks are shares of what was written", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{
      gate: "sanitizer",
      kept: 80,
      unreadable: 4,
      duplicates: 3,
      refused: { "wrong-transcript": 6, "wrong-language": 10 },
    }]));

    const made = auditOne(folder, "sanitizer").generation!;

    expect(made.written).toBe(100);
    expect(made.duplicates).toBe(3);
    expect(made.duplicateShare).toBe(0.03);
    // Six transcripts in the wrong shape and four rows that were not rows at all; a wrong language
    // is not a broken format.
    expect(made.formatBreakShare).toBe(0.1);
  });

  test("the share that survived the generator is read off the run's own meta", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{ gate: "sanitizer", kept: 35, unreadable: 0, refused: { "bad-answers": 5 } }]));

    const made = auditOne(folder, "sanitizer").generation!;

    expect(made.written).toBe(40);
    expect(made.kept).toBe(35);
    expect(made.keptShare).toBe(0.875);
    expect(made.refused["bad-answers"]).toBe(5);
  });

  test("rows the generator could not read at all count against what was written", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{ gate: "sanitizer", kept: 6, unreadable: 2, refused: { "too-large": 2 } }]));

    const made = auditOne(folder, "sanitizer").generation!;

    expect(made.written).toBe(10);
    expect(made.keptShare).toBe(0.6);
  });

  test("a folder carried in from somewhere else has no such figure and says so", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false) }]);

    const audit = auditFrozen({ folder, sample: 0, seed: "s" });

    expect(audit.gates[0]!.generation).toBeNull();
    expect(auditLines(audit).join("\n")).toContain("실행 기록이 없어 알 수 없습니다");
  });

  test("a meta that names no such gate gives no figure rather than a zero", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{ gate: "someone-else", kept: 1, refused: {} }]));

    expect(auditOne(folder, "sanitizer").generation).toBeNull();
  });

  test("a meta that cannot be read gives no figure rather than throwing", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), "이건 JSON이 아닙니다");

    expect(auditOne(folder, "sanitizer").generation).toBeNull();
  });

  test("the share is printed beside the sample's own", () => {
    const folder = scratch();

    freeze(folder, [{ spec: sanitizer, row: sanitizerRow(korean("a"), false) }]);
    writeFileSync(join(folder, metaFile), meta([{ gate: "sanitizer", kept: 9, unreadable: 0, refused: { "wrong-language": 1 } }]));

    const said = auditLines(auditFrozen({ folder, sample: 0, seed: "s" })).join("\n");

    expect(said).toContain("모델이 지은 10행 가운데 산 것 9 (90.0%)");
    expect(said).toContain("wrong-language 1");
  });
});

describe("auditing one gate at a time", () => {
  test("only the gates asked for are reported", () => {
    const folder = scratch();

    freeze(folder, [
      { spec: sanitizer, row: sanitizerRow(korean("a"), false) },
      { spec: classifier, row: classifier.example },
    ]);

    expect(auditFrozen({ folder, sample: 0, seed: "s" }).gates.map((one) => one.gate)).toEqual(["sanitizer", "system-documents"]);
    expect(auditFrozen({ folder, sample: 0, seed: "s", gates: ["sanitizer"] }).gates.map((one) => one.gate)).toEqual(["sanitizer"]);
  });

  test("one gate's rows are never counted against another's", () => {
    const folder = scratch();

    freeze(folder, [
      { spec: sanitizer, row: sanitizerRow(korean("a"), false) },
      { spec: sanitizer, row: sanitizerRow(korean("b"), true) },
      { spec: classifier, row: classifier.example },
    ]);

    const { rows } = readFrozen(folder);

    expect(auditGate("sanitizer", rows, 0, "s").rows).toBe(2);
    expect(auditGate("system-documents", rows, 0, "s").rows).toBe(1);
  });
});
