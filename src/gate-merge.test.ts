import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { auditFrozen } from "./laya-audit";
import { driveGates } from "./gate-run";
import { frozenGatesUnder, gatesTrainingWouldRefuse, mergeGates, readsAsRehearsal, rehearsalMetaFile } from "./gate-merge";
import { languageFile, metaFile } from "./laya-synth-run";
import { splitFiles } from "./laya-frozen";
import { datasetFolder, gateFolder } from "./roots";
import { synthesisFor } from "./laya-synth";
import { scratchDir } from "./scratch";

import type { DatasetRow, DatasetSplit } from "./laya-dataset";
import type { GateSynthesis, LanguageBucket, SynthAsk, SynthRow } from "./laya-synth";
import type { SynthAsker, SynthMeta } from "./laya-synth-run";

function scratch(): string {
  return scratchDir("bmo-gate-merge-");
}

function gate(name: string): GateSynthesis {
  const found = synthesisFor(name);

  if (found === null) {
    throw new Error(`no gate ${name}`);
  }

  return found;
}

const sanitizer = gate("sanitizer");
const notes = gate("knowledge-classifier");

function textFor(language: LanguageBucket, tag: string): string {
  if (language === "english") {
    return `I want to back up the router settings before the weekend. marker ${tag}`;
  }

  if (language === "mixed") {
    return [
      "백업 로그를 붙일게요.",
      "the backup finished with two warnings about permissions",
      "the second warning names a file the account cannot read",
      `이 줄이 마지막입니다. 표식 ${tag}`,
    ].join("\n");
  }

  return `라우터 설정을 주말 전에 백업해 두려고 합니다. 표식 ${tag}`;
}

function stateFor(spec: GateSynthesis, language: LanguageBucket, tag: string): SynthRow["state"] {
  const said = textFor(language, tag);

  if (typeof spec.example.state === "string") {
    return said;
  }

  return { ...(spec.example.state as Record<string, unknown>), note: said };
}

const standIn: SynthAsker = async (spec, ask: SynthAsk) => ({
  text: JSON.stringify(Array.from({ length: ask.count }, (_, index) => ({
    state: stateFor(spec, ask.language, `${ask.seed}-${index}`),
    questions: JSON.parse(JSON.stringify(spec.example.questions)) as SynthRow["questions"],
    gold: JSON.parse(JSON.stringify(spec.example.gold)) as SynthRow["gold"],
  }))),
  sessionId: `thread-${spec.gate}`,
  tokens: { inputTokens: 90, outputTokens: 400, cacheReadTokens: 11_008, cacheWriteTokens: 0 },
});

// A run of two gates, frozen into their own folders, which is what a merge is given.
async function runOf(gates: readonly GateSynthesis[], rows = 40): Promise<string> {
  const root = scratch();

  await driveGates({
    root,
    gates,
    rows,
    batchSize: 5,
    model: "gpt-5.6-terra",
    effort: "high",
    shares: { calibration: 0.15, test: 0.15 },
    atOnce: 10,
    resume: false,
    overwrite: false,
  }, standIn);

  return root;
}

function merged(root: string, extra: Partial<Parameters<typeof mergeGates>[0]> = {}) {
  return mergeGates({ root, into: datasetFolder(root), gates: null, overwrite: false, ...extra });
}

function rowsIn(folder: string, split: DatasetSplit): DatasetRow[] {
  const path = join(folder, splitFiles[split]);

  return !existsSync(path)
    ? []
    : readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as DatasetRow);
}

function metaOf(folder: string): SynthMeta {
  return JSON.parse(readFileSync(join(folder, metaFile), "utf8")) as SynthMeta;
}

describe("the gates put into one dataset", () => {
  test("the three splits carry every gate's rows together", async () => {
    const root = await runOf([sanitizer, notes]);
    const report = merged(root);

    expect(typeof report).not.toBe("string");

    for (const split of ["train", "calibration", "test"] as const) {
      const gates = new Set(rowsIn(datasetFolder(root), split).map((row) => row.gate));

      expect([...gates].sort()).toEqual([notes.gate, sanitizer.gate].sort());
    }
  });

  test("no row is rewritten on the way in", async () => {
    const root = await runOf([sanitizer]);

    merged(root);

    const before = rowsIn(gateFolder(root, sanitizer.gate), "train");
    const after = rowsIn(datasetFolder(root), "train");

    expect(after).toEqual(before);
  });

  test("every row keeps its language beside it", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    const ids = new Set((["train", "calibration", "test"] as const).flatMap((split) => rowsIn(datasetFolder(root), split).map((row) => row.id)));
    const said = readFileSync(join(datasetFolder(root), languageFile), "utf8")
      .split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { id: string; language: string });

    expect(said).toHaveLength(ids.size);
    expect(said.every((one) => ids.has(one.id))).toBe(true);
  });

  test("merging every gate that froze something needs no list", async () => {
    const root = await runOf([sanitizer, notes]);

    expect(frozenGatesUnder(root).sort()).toEqual([notes.gate, sanitizer.gate].sort());

    const report = merged(root);

    expect(typeof report === "string" ? report : report.gates.sort()).toEqual([notes.gate, sanitizer.gate].sort());
  });

  test("a gate asked for that froze nothing is said, not passed over", async () => {
    const root = await runOf([sanitizer]);

    expect(merged(root, { gates: [sanitizer.gate, notes.gate] })).toContain("굳은 데이터가 없습니다");
  });

  test("a run with nothing frozen under it is said rather than merged into an empty dataset", () => {
    expect(merged(scratch())).toContain("굳은 게이트가 없습니다");
  });
});

describe("the one meta the dataset carries", () => {
  test("its gate list holds every gate that went in", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    expect(metaOf(datasetFolder(root)).gates.map((one) => one.gate).sort()).toEqual([notes.gate, sanitizer.gate].sort());
  });

  test("the token tally is the gates' tallies added up", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    const gates = metaOf(datasetFolder(root)).gates;
    const summed = gates.reduce((all, one) => all + one.tokens.cacheReadTokens, 0);

    expect(metaOf(datasetFolder(root)).tokens.cacheReadTokens).toBe(summed);
    expect(summed).toBeGreaterThan(0);
  });

  test("the run-wide fields come across as they stand", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    expect(metaOf(datasetFolder(root))).toMatchObject({
      model: "gpt-5.6-terra",
      effort: "high",
      road: "codex",
      batchSize: 5,
      rowsAsked: 40,
      shares: { calibration: 0.15, test: 0.15 },
    });
  });

  test("the run began when its first gate began", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    const gates = [sanitizer, notes].map((spec) => metaOf(gateFolder(root, spec.gate)).started).sort();

    expect(metaOf(datasetFolder(root)).started).toBe(gates[0]!);
  });
});

describe("parts that do not belong to one another", () => {
  async function twoRuns(change: (meta: SynthMeta) => void): Promise<string> {
    const root = await runOf([sanitizer, notes]);
    const path = join(gateFolder(root, notes.gate), metaFile);
    const meta = JSON.parse(readFileSync(path, "utf8")) as SynthMeta;

    change(meta);
    writeFileSync(path, JSON.stringify(meta, null, 2));

    return root;
  }

  // The model, the effort and the road belong to a gate, not to a run: one run may build different
  // gates on different generators on purpose — sanitizer on J3090, the rest on codex — so a gate
  // whose meta names another model is merged, not refused. What must agree is the run's shape.
  test("a different model across gates is merged, not refused", async () => {
    const root = await twoRuns((meta) => {
      meta.model = "gpt-5.6-sol";
    });

    const report = merged(root);

    expect(typeof report).not.toBe("string");
    expect(typeof report === "string" ? "" : report.gates.sort()).toEqual([notes.gate, sanitizer.gate].sort());
  });

  test("a different effort across gates is merged, not refused", async () => {
    const root = await twoRuns((meta) => {
      meta.effort = "medium";
    });

    expect(typeof merged(root)).not.toBe("string");
  });

  test("gates written on different roads merge and both roads are recorded", async () => {
    const root = await twoRuns((meta) => {
      meta.road = "j3090";
      meta.roads = ["j3090"];
      meta.sessionHeld = false;
      meta.cacheReused = false;
    });

    const report = merged(root);

    expect(typeof report).not.toBe("string");
    expect(typeof report === "string" ? [] : report.meta.roads).toEqual(["codex", "j3090"]);
  });

  test("a different batch size is refused", async () => {
    const root = await twoRuns((meta) => {
      meta.batchSize = 20;
    });

    expect(merged(root)).toContain("batchSize");
  });

  test("a different split share is refused", async () => {
    const root = await twoRuns((meta) => {
      meta.shares = { calibration: 0.2, test: 0.15 };
    });

    expect(merged(root)).toContain("calibration 몫");
  });

  test("nothing is written when the parts are refused", async () => {
    const root = await twoRuns((meta) => {
      meta.batchSize = 20;
    });

    merged(root);

    expect(existsSync(join(datasetFolder(root), splitFiles.train))).toBe(false);
  });
});

describe("a dataset that already stands", () => {
  test("is not written over unless the merge says outright that it means to", async () => {
    const root = await runOf([sanitizer]);

    merged(root);

    expect(merged(root)).toContain("이미 굳은 데이터가 있습니다");
  });

  test("is written over when it does", async () => {
    const root = await runOf([sanitizer]);

    merged(root);

    expect(typeof merged(root, { overwrite: true })).not.toBe("string");
  });

  test("the refusal names the flag that would allow it", async () => {
    const root = await runOf([sanitizer]);

    merged(root);

    expect(merged(root)).toContain("--overwrite");
  });
});

describe("a folder holding rows that are not its gate's", () => {
  test("is refused and names whose rows they are", async () => {
    const root = await runOf([sanitizer, notes]);
    const wrong = join(gateFolder(root, notes.gate), splitFiles.train);
    const mine = rowsIn(gateFolder(root, sanitizer.gate), "train")[0]!;

    writeFileSync(wrong, `${[JSON.stringify(mine), ...rowsIn(gateFolder(root, notes.gate), "train").map((row) => JSON.stringify(row))].join("\n")}\n`);

    expect(merged(root)).toContain(`${sanitizer.gate} 게이트의 행이 있습니다`);
  });
});

describe("the same row id standing twice", () => {
  test("goes in once and is counted, so the dataset holds no row twice", async () => {
    const root = await runOf([sanitizer]);
    const folder = gateFolder(root, sanitizer.gate);
    const train = rowsIn(folder, "train");
    const doubled = [...train, train[0]!];

    // A row standing in a folder twice. Freezing deduplicates within one gate as it writes, so
    // this only arises where a folder has been written by something other than a finished run —
    // and the dataset must still hold one of each row rather than two.
    writeFileSync(join(folder, splitFiles.train), `${doubled.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const report = merged(root);

    expect(typeof report === "string" ? report : report.duplicates).toBe(1);
    expect(rowsIn(datasetFolder(root), "train")).toHaveLength(train.length);
    expect(new Set(rowsIn(datasetFolder(root), "train").map((row) => row.id)).size).toBe(train.length);
  });
});

describe("what the training driver would make of the dataset", () => {
  test("it reads as real data rather than as a rehearsal", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    expect(readsAsRehearsal(datasetFolder(root))).toBe(false);
    expect(existsSync(join(datasetFolder(root), rehearsalMetaFile))).toBe(false);
  });

  test("every gate can be cut out of it, with none of the three splits empty", async () => {
    const root = await runOf([sanitizer, notes]);
    const report = merged(root);

    expect(gatesTrainingWouldRefuse(datasetFolder(root), typeof report === "string" ? [] : report.gates)).toEqual([]);
  });

  test("a gate short in one split is named, rather than found out by a training run", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    // One gate's test rows taken away: the driver refuses that gate outright and trains the rest.
    const kept = rowsIn(datasetFolder(root), "test").filter((row) => row.gate !== notes.gate);

    writeFileSync(join(datasetFolder(root), splitFiles.test), `${kept.map((row) => JSON.stringify(row)).join("\n")}\n`);

    expect(gatesTrainingWouldRefuse(datasetFolder(root), [sanitizer.gate, notes.gate])).toEqual([notes.gate]);
  });

  test("a rehearsal mark on a source gate's rows keeps it out of the dataset", async () => {
    const root = await runOf([sanitizer]);
    const path = join(gateFolder(root, sanitizer.gate), splitFiles.train);
    const rows = rowsIn(gateFolder(root, sanitizer.gate), "train").map((row, index) => (index === 0 ? { ...row, rehearsal: true } : row));

    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    expect(merged(root)).toContain("리허설 행이 섞여 있습니다");
  });

  test("a rehearsal meta beside a source gate keeps it out too", async () => {
    const root = await runOf([sanitizer]);

    writeFileSync(join(gateFolder(root, sanitizer.gate), rehearsalMetaFile), JSON.stringify({ kind: "laya-rehearsal" }));

    expect(merged(root)).toContain("리허설 데이터입니다");
  });
});

describe("what the audit makes of the dataset", () => {
  test("it reads the merged folder per gate", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    const audit = auditFrozen({ folder: datasetFolder(root), sample: 0, seed: "merge", gates: [] });

    expect(audit.gates.map((one) => one.gate).sort()).toEqual([notes.gate, sanitizer.gate].sort());
  });

  test("every gate's rows are counted as its own", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    const audit = auditFrozen({ folder: datasetFolder(root), sample: 0, seed: "merge", gates: [] });

    for (const one of audit.gates) {
      expect(one.rows).toBeGreaterThan(0);
      expect(one.rows).toBe(one.splits.train + one.splits.calibration + one.splits.test);
    }
  });

  test("the generation figures come through, so the bars have something to read", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    const audit = auditFrozen({ folder: datasetFolder(root), sample: 0, seed: "merge", gates: [] });

    for (const one of audit.gates) {
      expect(one.generation).not.toBeNull();
      expect(one.generation!.written).toBeGreaterThan(0);
    }
  });

  test("the language sidecar lines up, so no row is counted as a mismatch", async () => {
    const root = await runOf([sanitizer, notes]);

    merged(root);

    const audit = auditFrozen({ folder: datasetFolder(root), sample: 0, seed: "merge", gates: [] });

    for (const one of audit.gates) {
      expect(one.sidecarMismatch).toBe(0);
      expect(one.unreadable).toBe(0);
    }
  });
});

describe("a dataset put somewhere of its own", () => {
  test("goes where it was told rather than under the run", async () => {
    const root = await runOf([sanitizer]);
    const elsewhere = join(scratch(), "그 데이터셋");

    const report = merged(root, { into: elsewhere });

    expect(typeof report === "string" ? "" : report.folder).toBe(elsewhere);
    expect(existsSync(join(elsewhere, splitFiles.train))).toBe(true);
    expect(existsSync(join(datasetFolder(root), splitFiles.train))).toBe(false);
  });
});
