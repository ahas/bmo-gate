import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { auditFrozen } from "../../training/tooling/src/laya-audit";
import { driveGates } from "../../training/tooling/src/gate-run";
import { frozenGatesUnder, gatesTrainingWouldRefuse, growingCounts, mergeGates, readsAsRehearsal } from "../../training/tooling/src/gate-merge";
import { rehearsalMetaFile } from "../../training/tooling/src/laya-rehearsal";
import { batchName, batchesFolder, freezeBatch, languageFile, metaFile, writeProgress } from "../../training/tooling/src/laya-synth-run";
import { earlierWordings } from "../../training/tooling/src/laya-wording";
import { splitFiles } from "../../training/tooling/src/laya-frozen";
import { datasetFolder, gateFolder } from "../../training/tooling/src/roots";
import { synthesisFor } from "../../training/tooling/src/laya-synth";
import { scratchDir } from "./scratch";

import type { DatasetRow, DatasetSplit } from "../../training/tooling/src/laya-dataset";
import type { LayaQuestion } from "../../training/tooling/src/laya";
import type { FrozenRow } from "../../training/tooling/src/laya-synth-run";
import type { GateSynthesis, LanguageBucket, SynthAsk, SynthRow } from "../../training/tooling/src/laya-synth";
import type { SynthAsker, SynthMeta } from "../../training/tooling/src/laya-synth-run";
import { useToolingSettings } from "./settings";

useToolingSettings();

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
      "\uBC31\uC5C5 \uB85C\uADF8\uB97C \uBD99\uC77C\uAC8C\uC694.",
      "the backup finished with two warnings about permissions",
      "the second warning names a file the account cannot read",
      `\uC774 \uC904\uC774 \uB9C8\uC9C0\uB9C9\uC785\uB2C8\uB2E4. \uD45C\uC2DD ${tag}`,
    ].join("\n");
  }

  return `\uB77C\uC6B0\uD130 \uC124\uC815\uC744 \uC8FC\uB9D0 \uC804\uC5D0 \uBC31\uC5C5\uD574 \uB450\uB824\uACE0 \uD569\uB2C8\uB2E4. \uD45C\uC2DD ${tag}`;
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

  test("a row asking its gate's own wording goes in as it stands", async () => {
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

    expect(merged(root, { gates: [sanitizer.gate, notes.gate] })).toContain("holds no frozen data");
  });

  test("a run with nothing frozen under it is said rather than merged into an empty dataset", () => {
    expect(merged(scratch())).toContain("is frozen");
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
  // gates on different generators on purpose — sanitizer on the local-model road, the rest on codex — so a gate
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
      meta.road = "local";
      meta.roads = ["local"];
      meta.sessionHeld = false;
      meta.cacheReused = false;
    });

    const report = merged(root);

    expect(typeof report).not.toBe("string");
    expect(typeof report === "string" ? [] : report.meta.roads).toEqual(["codex", "local"]);
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

    expect(merged(root)).toContain("a calibration share");
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

    expect(merged(root)).toContain("already holds a frozen dataset");
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

    expect(merged(root)).toContain(`holds a row of the ${sanitizer.gate} gate`);
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

    expect(merged(root)).toContain("holds rehearsal rows");
  });

  test("a rehearsal meta beside a source gate keeps it out too", async () => {
    const root = await runOf([sanitizer]);

    writeFileSync(join(gateFolder(root, sanitizer.gate), rehearsalMetaFile), JSON.stringify({ kind: "laya-rehearsal" }));

    expect(merged(root)).toContain("rehearsal data, which cannot be merged");
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

describe("a cut taken while the judging goes on", () => {
  // A gate part-way through: the batches named are frozen, the rest are not there yet.
  function judgingGate(root: string, batches: readonly number[]): string {
    const folder = gateFolder(root, "sanitizer");

    writeProgress(folder, {
      started: "2026-09-23T13:23:29.866Z", model: "gpt-5.6-terra", effort: "high", road: "codex", rows: 40, batchSize: 5,
      shares: { calibration: 0.15, test: 0.15 },
      gates: { sanitizer: { done: batches.length, sessionId: null, kept: 0, refused: {}, unreadable: 0, lostBatches: 0,
        tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    });
    for (const index of batches) {
      freezeBatch(folder, "sanitizer", index, [0, 1].map((at) => ({
        row: { id: `sanitizer:${index}-${at}`, gate: "sanitizer", split: at === 0 ? "train" : "test", state: "s", questions: "{}",
          gold: JSON.stringify({ q: { label: "true" } }) },
        language: "korean" as const,
      })));
    }

    return folder;
  }

  test("counts the questions of the rarer answer, a contested gold toward neither", () => {
    const root = scratch();
    const folder = judgingGate(root, []);
    const gold = (yes: number) => ({ type: "noul", noul: yes, probabilities: { true: yes, false: 1 - yes } });

    freezeBatch(folder, "sanitizer", 0, [
      { a: gold(0.95), b: gold(0.05), c: gold(0.5) },
      { a: gold(0.05), b: gold(0.2) },
      { a: gold(0.9) },
    ].map((golds, at) => ({
      row: { id: `sanitizer:r${at}`, gate: "sanitizer", split: "train", state: "s", questions: "{}", gold: JSON.stringify(golds) },
      language: "korean" as const,
    })));

    const counts = growingCounts(root);

    expect(typeof counts === "string" ? counts : counts.map((one) => one.rarer)).toEqual([2]);
  });

  test("a gate still being judged is refused without the word, and the refusal names it", () => {
    const root = scratch();

    judgingGate(root, [0, 1]);

    expect(merged(root, { gates: ["sanitizer"] })).toContain("--growing");
  });

  test("is cut at the last whole batch before a gap, and writes nothing into the gate's folder", () => {
    const root = scratch();
    const folder = judgingGate(root, [0, 1, 3]);

    // A batch being written stands under a hidden name until it is whole, and is not read.
    writeFileSync(join(folder, "batches", `.${batchName("sanitizer", 2)}.writing`), "{broken");

    const report = merged(root, { growing: true });

    expect(typeof report === "string" ? report : report.parts).toEqual([{
      gate: "sanitizer", rows: { train: 2, calibration: 0, test: 2 }, finished: false, started: "2026-09-23T13:23:29.866Z",
      rarer: 0,
    }]);
    expect(rowsIn(datasetFolder(root), "test").map((row) => row.id)).toEqual(["sanitizer:0-1", "sanitizer:1-1"]);
    expect(existsSync(join(folder, splitFiles.train))).toBe(false);
  });

  test("a finished gate cut from its batches holds exactly the rows its split files hold", async () => {
    const root = await runOf([sanitizer]);
    const whole = join(scratch(), "whole");
    const cut = join(scratch(), "cut");

    merged(root, { into: whole });

    const report = merged(root, { into: cut, growing: true });

    expect(typeof report === "string" ? report : report.parts[0]!.finished).toBe(true);
    for (const split of ["train", "calibration", "test"] as const) {
      expect(rowsIn(cut, split)).toEqual(rowsIn(whole, split));
    }
  });
});

// A run started before a gate's questions were reworded writes the earlier wording until it is taken up
// again, and the gate's own after that (docs/gate-data.md, 「A question reworded」).
describe("a gate whose rows ask its question in two wordings", () => {
  const rules = gate("room-rules");
  const splits = ["train", "calibration", "test"] as const;

  // The gate's own transcript shape, so its rows stand; the line's language is the message's.
  const transcriptAsker: SynthAsker = async (spec, ask: SynthAsk) => ({
    text: JSON.stringify(Array.from({ length: ask.count }, (_, index) => ({
      state: `Mina (id 4471902): ${textFor(ask.language, `${ask.seed}-${index}`)}`,
      questions: JSON.parse(JSON.stringify(spec.example.questions)) as SynthRow["questions"],
      gold: JSON.parse(JSON.stringify(spec.example.gold)) as SynthRow["gold"],
    }))),
    sessionId: `thread-${spec.gate}`,
    tokens: { inputTokens: 90, outputTokens: 400, cacheReadTokens: 11_008, cacheWriteTokens: 0 },
  });

  async function rulesRun(): Promise<string> {
    const root = scratch();

    await driveGates({
      root,
      gates: [rules, notes],
      rows: 40,
      batchSize: 5,
      model: "gpt-5.6-terra",
      effort: "high",
      shares: { calibration: 0.15, test: 0.15 },
      atOnce: 10,
      resume: false,
      overwrite: false,
    }, async (spec, ask, session) => spec.gate === rules.gate ? transcriptAsker(spec, ask, session) : standIn(spec, ask, session));

    return root;
  }

  // The row as the run wrote it before the rewording: the earlier question and candidate word.
  function earlier(row: DatasetRow): DatasetRow {
    const wordings = earlierWordings(rules.gate);
    const questions = JSON.parse(row.questions) as Record<string, LayaQuestion>;

    for (const [slug, question] of Object.entries(questions)) {
      question.instructions = question.instructions.replace(
        `${rules.questions[0]!.instructions} ${rules.candidateWord!} ${slug}:`,
        `${wordings.questions.needed![0]!} ${wordings.candidateWords[0]!} ${slug}:`,
      );
    }

    return { ...row, questions: JSON.stringify(questions) };
  }

  function rewrite(path: string, change: (line: string, at: number) => string): void {
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");

    writeFileSync(path, `${lines.map(change).join("\n")}\n`);
  }

  function asksOwnWording(row: DatasetRow): boolean {
    return Object.entries(JSON.parse(row.questions) as Record<string, LayaQuestion>)
      .every(([slug, question]) => question.instructions.startsWith(`${rules.questions[0]!.instructions} ${rules.candidateWord!} ${slug}: `));
  }

  test("a finished gate merges into one dataset keyed by the gate, every row asking the gate's own wording", async () => {
    const root = await rulesRun();
    const folder = gateFolder(root, rules.gate);
    const frozen = splits.flatMap((split) => rowsIn(folder, split));

    expect(frozen.length).toBeGreaterThan(0);

    for (const split of splits) {
      rewrite(join(folder, splitFiles[split]), (line, at) => at % 2 === 0 ? JSON.stringify(earlier(JSON.parse(line) as DatasetRow)) : line);
    }

    const written = splits.flatMap((split) => rowsIn(folder, split));

    expect(written.some(asksOwnWording) && !written.every(asksOwnWording)).toBe(true);

    const report = merged(root);

    expect(typeof report === "string" ? report : report.gates.sort()).toEqual([notes.gate, rules.gate].sort());

    const landed = splits.flatMap((split) => rowsIn(datasetFolder(root), split).map((row) => ({ ...row, split }))).filter((row) => row.gate === rules.gate);

    expect(landed).toHaveLength(frozen.length);
    expect(landed.every(asksOwnWording)).toBe(true);
    expect(new Map(landed.map((row) => [row.id, row.split]))).toEqual(new Map(frozen.map((row) => [row.id, row.split])));
    expect(landed.map((row) => row.questions).sort()).toEqual(frozen.map((row) => row.questions).sort());
    // What stands in the gate's folder keeps the words it was written in.
    expect(splits.flatMap((split) => rowsIn(folder, split))).toEqual(written);
  });

  test("a growing cut reads the batches the same way", async () => {
    const root = await rulesRun();
    const folder = gateFolder(root, rules.gate);
    const frozen = splits.flatMap((split) => rowsIn(folder, split));

    expect(frozen.length).toBeGreaterThan(0);
    rewrite(join(folder, batchesFolder, batchName(rules.gate, 0)), (line) => {
      const one = JSON.parse(line) as FrozenRow;

      return JSON.stringify({ ...one, row: earlier(one.row) });
    });

    const report = merged(root, { growing: true });

    expect(typeof report === "string" ? report : report.gates.sort()).toEqual([notes.gate, rules.gate].sort());

    const landed = splits.flatMap((split) => rowsIn(datasetFolder(root), split)).filter((row) => row.gate === rules.gate);

    expect(landed).toHaveLength(frozen.length);
    expect(landed.every(asksOwnWording)).toBe(true);
  });
});

describe("a dataset put somewhere of its own", () => {
  test("goes where it was told rather than under the run", async () => {
    const root = await runOf([sanitizer]);
    const elsewhere = join(scratch(), "\uADF8 \uB370\uC774\uD130\uC14B");

    const report = merged(root, { into: elsewhere });

    expect(typeof report === "string" ? "" : report.folder).toBe(elsewhere);
    expect(existsSync(join(elsewhere, splitFiles.train))).toBe(true);
    expect(existsSync(join(datasetFolder(root), splitFiles.train))).toBe(false);
  });
});
