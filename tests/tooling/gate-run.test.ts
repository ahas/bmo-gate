import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { claimsIn } from "../../training/tooling/src/gate-claim";
import { clearGate, driveGates, readRunStanding, standingLines } from "../../training/tooling/src/gate-run";
import { gateFolder, gatesFolderName } from "../../training/tooling/src/roots";
import { batchName, batchesFolder, freezeBatch, noTokens, progressFile, readProgress, writeProgress } from "../../training/tooling/src/laya-synth-run";
import { unjudgedFile } from "../../training/tooling/src/real-rows";
import { splitFiles } from "../../training/tooling/src/laya-frozen";
import { synthesisFor } from "../../training/tooling/src/laya-synth";
import { scratchDir } from "./scratch";

import type { GateSynthesis, LanguageBucket, SynthAsk, SynthRow } from "../../training/tooling/src/laya-synth";
import type { SynthAnswer, SynthAsker } from "../../training/tooling/src/laya-synth-run";
import { useToolingSettings } from "./settings";

useToolingSettings();

function scratch(): string {
  return scratchDir("bmo-gate-run-");
}

function gate(name: string): GateSynthesis {
  const found = synthesisFor(name);

  if (found === null) {
    throw new Error(`no gate ${name}`);
  }

  return found;
}

// Two gates that are handed no transcript, so a stand-in can write their state in whichever
// language a batch asked for without having to invent a transcript line shape. They also differ
// in what they answer — one yes or no, the other one of four — so the driver is not only ever
// seen carrying one kind of gate.
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

// A state of the shape that gate is really handed: a bare string where the gate takes one, and
// the gate's own fields filled in where it takes those, with the free text carrying the language
// the batch asked for.
function stateFor(spec: GateSynthesis, language: LanguageBucket, tag: string): SynthRow["state"] {
  const said = textFor(language, tag);

  if (typeof spec.example.state === "string") {
    return said;
  }

  return { ...(spec.example.state as Record<string, unknown>), note: said };
}

function rowsFor(spec: GateSynthesis, ask: SynthAsk, count: number): SynthRow[] {
  return Array.from({ length: count }, (_, index) => ({
    state: stateFor(spec, ask.language, `${ask.seed}-${index}`),
    questions: JSON.parse(JSON.stringify(spec.example.questions)) as SynthRow["questions"],
    gold: JSON.parse(JSON.stringify(spec.example.gold)) as SynthRow["gold"],
  }));
}

// A stand-in that answers every batch, and says which gate was asked and when, so a test can see
// that two gates were in the air at the same time rather than one after the other.
function standIn(watch?: { started: string[]; finished: string[]; hold?: Map<string, Promise<void>> }): SynthAsker {
  return async (spec, ask) => {
    watch?.started.push(spec.gate);

    await watch?.hold?.get(spec.gate);

    watch?.finished.push(spec.gate);

    return {
      text: JSON.stringify(rowsFor(spec, ask, ask.count)),
      sessionId: `thread-${spec.gate}`,
      tokens: { inputTokens: 100, outputTokens: 400, cacheReadTokens: 900, cacheWriteTokens: 50 },
    } satisfies SynthAnswer;
  };
}

// Every row a gate has frozen, across the three splits, which is what a reader of the dataset
// would get.
function frozenRows(root: string, gate: string): number {
  return Object.values(splitFiles).reduce((all, name) => {
    const path = join(gateFolder(root, gate), name);

    return all + (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length : 0);
  }, 0);
}

const driving = (root: string, extra: Partial<Parameters<typeof driveGates>[0]> = {}) => ({
  root,
  gates: [sanitizer, notes],
  rows: 4,
  batchSize: 2,
  model: "gpt-5.6-terra",
  effort: "high",
  shares: { calibration: 0.15, test: 0.15 },
  atOnce: 10,
  resume: false,
  overwrite: false,
  ...extra,
});

describe("the gates written beside each other", () => {
  test("each one lands in a folder of its own", async () => {
    const root = scratch();

    await driveGates(driving(root), standIn());

    for (const spec of [sanitizer, notes]) {
      expect(existsSync(join(gateFolder(root, spec.gate), splitFiles.train))).toBe(true);
    }
  });

  test("no gate's batches, progress or thread land in another's folder", async () => {
    const root = scratch();

    await driveGates(driving(root), standIn());

    for (const spec of [sanitizer, notes]) {
      const progress = readProgress(gateFolder(root, spec.gate))!;

      expect(Object.keys(progress.gates)).toEqual([spec.gate]);
      expect(progress.gates[spec.gate]!.sessionId).toBe(`thread-${spec.gate}`);
    }
  });

  test("they are in the air together rather than one after the other", async () => {
    const root = scratch();
    const watch = { started: [] as string[], finished: [] as string[], hold: new Map<string, Promise<void>>() };
    let release = (): void => {};

    // The first gate asked is held until the other has been asked too. If the driver ran them one
    // after another this would never come back, because the second would be waiting on the first.
    watch.hold.set(sanitizer.gate, new Promise<void>((settle) => {
      release = settle;
    }));

    const running = driveGates(driving(root), standIn(watch));

    while (!watch.started.includes(notes.gate)) {
      await new Promise((settle) => setTimeout(settle, 1));
    }

    expect(watch.finished).not.toContain(sanitizer.gate);
    release();
    await running;

    expect(watch.finished).toContain(sanitizer.gate);
  });

  test("one lane at a time is still every gate, just not at once", async () => {
    const root = scratch();

    const outcomes = await driveGates(driving(root, { atOnce: 1 }), standIn());

    expect(outcomes.map((one) => one.state)).toEqual(["done", "done"]);
  });

  test("the outcomes come back in the order the gates were given", async () => {
    const root = scratch();

    const outcomes = await driveGates(driving(root, { atOnce: 1 }), standIn());

    expect(outcomes.map((one) => one.gate)).toEqual([sanitizer.gate, notes.gate]);
  });
});

describe("a gate that falls over", () => {
  const breaks: SynthAsker = async (spec, ask) => {
    if (spec.gate === sanitizer.gate) {
      throw new Error("codex did not write the batch");
    }

    return { text: JSON.stringify(rowsFor(spec, ask, ask.count)), sessionId: "held", tokens: noTokens };
  };

  test("costs only itself, and the others finish", async () => {
    const root = scratch();

    const outcomes = await driveGates(driving(root), breaks);

    expect(outcomes.find((one) => one.gate === sanitizer.gate)!.state).toBe("failed");
    expect(outcomes.find((one) => one.gate === notes.gate)!.state).toBe("done");
    expect(existsSync(join(gateFolder(root, notes.gate), splitFiles.train))).toBe(true);
  });

  test("says what stopped it rather than just that it stopped", async () => {
    const root = scratch();

    const outcomes = await driveGates(driving(root), breaks);

    expect(outcomes.find((one) => one.gate === sanitizer.gate)!.fault).toContain("codex did not write the batch");
  });
});

describe("taking a run up again", () => {
  // A gate that got two batches in and then died.
  async function halfWritten(root: string): Promise<void> {
    await driveGates(driving(root, { rows: 6 }), async (spec, ask) => {
      if (spec.gate === sanitizer.gate && ask.seed.endsWith("-3")) {
        throw new Error("\uC138\uC158\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4");
      }

      return { text: JSON.stringify(rowsFor(spec, ask, ask.count)), sessionId: "held", tokens: noTokens };
    });
  }

  test("the interrupted gate goes on from its next batch", async () => {
    const root = scratch();

    await halfWritten(root);

    const seeds: string[] = [];

    await driveGates(driving(root, { rows: 6, resume: true }), async (spec, ask) => {
      seeds.push(ask.seed);

      return { text: JSON.stringify(rowsFor(spec, ask, ask.count)), sessionId: "held", tokens: noTokens };
    });

    expect(seeds).toEqual([`${sanitizer.gate}-3`]);
  });

  test("the gates that finished are left exactly as they stand", async () => {
    const root = scratch();

    await halfWritten(root);

    const landed = join(gateFolder(root, notes.gate), splitFiles.train);
    const before = readFileSync(landed, "utf8");

    const outcomes = await driveGates(driving(root, { rows: 6, resume: true }), standIn());

    expect(outcomes.find((one) => one.gate === notes.gate)!.state).toBe("stands");
    expect(readFileSync(landed, "utf8")).toBe(before);
  });

  test("a finished gate is not an error, so a run of nine finished and one to go still comes back", async () => {
    const root = scratch();

    await halfWritten(root);

    const outcomes = await driveGates(driving(root, { rows: 6, resume: true }), standIn());

    expect(outcomes.map((one) => one.state).sort()).toEqual(["done", "stands"]);
  });
});

describe("a folder that is not this run's to write", () => {
  test("a frozen gate is refused when nothing said to overwrite it", async () => {
    const root = scratch();

    await driveGates(driving(root), standIn());

    const outcomes = await driveGates(driving(root), standIn());

    expect(outcomes.map((one) => one.state)).toEqual(["refused", "refused"]);
    expect(outcomes[0]!.refusal).toContain("already holds a frozen dataset");
  });

  test("a half-written gate is refused too, and the refusal names both ways out", async () => {
    const root = scratch();
    const folder = gateFolder(root, sanitizer.gate);

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, progressFile), "{}");

    const outcomes = await driveGates(driving(root, { gates: [sanitizer] }), standIn());

    expect(outcomes[0]!.state).toBe("refused");
    expect(outcomes[0]!.refusal).toContain("--resume");
    expect(outcomes[0]!.refusal).toContain("--overwrite");
  });

  test("a refused gate has nothing written into it", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer] }), standIn());

    const landed = join(gateFolder(root, sanitizer.gate), splitFiles.train);
    const before = readFileSync(landed, "utf8");

    await driveGates(driving(root, { gates: [sanitizer] }), standIn());

    expect(readFileSync(landed, "utf8")).toBe(before);
  });
});

describe("a gate told to start over", () => {
  test("keeps nothing of the run it replaces", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 6 }), standIn());

    // A batch of the old run that the new, shorter plan would never write over. Read back at
    // freezing time it would put the replaced run's rows into the replacement's dataset.
    const stale = join(gateFolder(root, sanitizer.gate), batchesFolder, batchName(sanitizer.gate, 2));

    expect(existsSync(stale)).toBe(true);

    await driveGates(driving(root, { gates: [sanitizer], rows: 2, overwrite: true }), standIn());

    expect(existsSync(stale)).toBe(false);
  });

  test("the dataset it leaves holds only what it wrote", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 6 }), standIn());

    expect(frozenRows(root, sanitizer.gate)).toBe(6);

    // Two rows replacing six. Freezing reads every batch standing in the folder, so a run that
    // left the replaced run's batches behind would freeze all eight ids and call it one dataset.
    await driveGates(driving(root, { gates: [sanitizer], rows: 2, overwrite: true }), standIn());

    expect(frozenRows(root, sanitizer.gate)).toBe(2);
  });

  test("the clearing refuses any folder that is not under this run's own gates", () => {
    const root = scratch();
    const elsewhere = scratch();

    // The guard is on the path rather than on the flag, so an overwrite can only ever take away
    // a gate folder of the run that asked for it.
    expect(() => clearGate(root, elsewhere)).toThrow("is not a gate folder of this run");
    expect(() => clearGate(root, root)).toThrow();
    expect(() => clearGate(root, join(root, gatesFolderName))).toThrow();
    expect(existsSync(elsewhere)).toBe(true);
  });

  test("the clearing takes away the gate folder it is given", () => {
    const root = scratch();
    const folder = gateFolder(root, sanitizer.gate);

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, progressFile), "{}");

    clearGate(root, folder);

    expect(existsSync(folder)).toBe(false);
  });
});

describe("how far a run got, read off the folder", () => {
  test("a gate nobody has started has not started", () => {
    const root = scratch();

    expect(readRunStanding(root, [sanitizer])[0]).toMatchObject({ state: "not started", done: 0, planned: 0, kept: 0 });
  });

  test("a finished gate reads as frozen, with its batches and rows counted", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 6 }), standIn());

    expect(readRunStanding(root, [sanitizer])[0]).toMatchObject({ state: "frozen", done: 3, planned: 3, kept: 6 });
  });

  test("an interrupted gate reads as still going, at the batch it reached", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 6 }), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("\uC138\uC158\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4");
      }

      return { text: JSON.stringify(rowsFor(spec, ask, ask.count)), sessionId: "held", tokens: noTokens };
    });

    expect(readRunStanding(root, [sanitizer])[0]).toMatchObject({ state: "running", done: 2, planned: 3, kept: 4 });
  });

  // A judging pass records the build's cap on rows, which says nothing of how many rows there are
  // to judge; its plan is the one cut from the rows in the folder.
  test("a judging gate is planned over the rows standing in its folder, not the build's cap", () => {
    const root = scratch();
    const folder = gateFolder(root, sanitizer.gate);
    const unjudged = Array.from({ length: 7 }, (_, index) => ({
      id: `row-${index}`, gate: sanitizer.gate, split: "train", state: {}, questions: { keeps: {} },
    }));

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, unjudgedFile), unjudged.map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeProgress(folder, {
      started: "2026-09-25T00:00:00.000Z", model: "claude-sonnet-5", effort: "high", road: "claude",
      rows: 6_000, batchSize: 5, answerCap: 100, builtAt: "2026-09-25T00:00:00.000Z",
      shares: { calibration: 0.15, test: 0.15 }, gates: {},
    });
    freezeBatch(folder, sanitizer.gate, 0, []);

    expect(readRunStanding(root, [sanitizer])[0]).toMatchObject({ state: "running", done: 1, planned: 2 });
  });

  test("it counts the batches on disk, not the count a killed run left behind", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 6 }), standIn());

    // What a run killed between freezing a batch and recording it leaves: the batch stands, the
    // count is one behind.
    const folder = gateFolder(root, sanitizer.gate);
    const progress = readProgress(folder)!;

    progress.gates[sanitizer.gate]!.done = 1;
    writeFileSync(join(folder, progressFile), JSON.stringify(progress));

    expect(readRunStanding(root, [sanitizer])[0]!.done).toBe(3);
  });

  test("a lost batch is counted where it happened", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 4 }), async () => ({
      text: "\uD589 \uBAA9\uB85D\uC774 \uC544\uB2C8\uB77C \uADF8\uB0E5 \uD560 \uB9D0",
      sessionId: "held",
      tokens: noTokens,
    }));

    expect(readRunStanding(root, [sanitizer])[0]).toMatchObject({ lostBatches: 2, kept: 0 });
  });

  test("the thread a gate rode is visible, which is what says the prefix is cached", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 2 }), standIn());

    expect(readRunStanding(root, [sanitizer])[0]!.threadHeld).toBe(true);
  });

  // The road is in the progress from the first batch on, and a gate takes a day to freeze. A
  // reading that waited for the meta would answer which road a gate is on a day after it was asked.
  test("a gate still writing names the road, the model and the effort writing it", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 6, model: "qwen3.8-27b", effort: "none", road: "local" }), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("\uC138\uC158\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4");
      }

      return { text: JSON.stringify(rowsFor(spec, ask, ask.count)), sessionId: null, tokens: noTokens };
    });

    expect(readRunStanding(root, [sanitizer])[0])
      .toMatchObject({ state: "running", road: "local", roads: ["local"], model: "qwen3.8-27b", effort: "none" });
  });

  test("a gate carried onto a second road names both, in the order they drove it", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 6 }), async (spec, ask) => {
      if (ask.seed.endsWith("-2")) {
        throw new Error("codex did not write the batch");
      }

      return { text: JSON.stringify(rowsFor(spec, ask, ask.count)), sessionId: "held", tokens: noTokens };
    });

    await driveGates(driving(root, { gates: [sanitizer], rows: 6, resume: true, model: "qwen3.8-27b", effort: "none", road: "local" }), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("\uC138\uC158\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4");
      }

      return { text: JSON.stringify(rowsFor(spec, ask, ask.count)), sessionId: null, tokens: noTokens };
    });

    expect(readRunStanding(root, [sanitizer])[0]).toMatchObject({ road: "local", roads: ["codex", "local"] });
  });

  // The thread id the codex stretch left behind stays in the progress. Read as a held thread it
  // would say a gate sending its whole prefix afresh every batch was reading it from a cache.
  test("a gate taken onto a road that holds no thread is not riding one", async () => {
    const root = scratch();

    await driveGates(driving(root, { gates: [sanitizer], rows: 6 }), async (spec, ask) => {
      if (ask.seed.endsWith("-2")) {
        throw new Error("codex did not write the batch");
      }

      return { text: JSON.stringify(rowsFor(spec, ask, ask.count)), sessionId: "held", tokens: noTokens };
    });

    expect(readRunStanding(root, [sanitizer])[0]!.threadHeld).toBe(true);

    await driveGates(driving(root, { gates: [sanitizer], rows: 6, resume: true, model: "qwen3.8-27b", effort: "none", road: "local" }), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("\uC138\uC158\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4");
      }

      return { text: JSON.stringify(rowsFor(spec, ask, ask.count)), sessionId: null, tokens: noTokens };
    });

    expect(readProgress(gateFolder(root, sanitizer.gate))!.gates[sanitizer.gate]!.sessionId).toBe("held");
    expect(readRunStanding(root, [sanitizer])[0]!.threadHeld).toBe(false);
  });

  test("what it says matches what is in the folder", async () => {
    const root = scratch();

    await driveGates(driving(root, { rows: 4 }), standIn());

    const lines = standingLines(readRunStanding(root, [sanitizer, notes]));

    expect(lines[0]).toContain(`${sanitizer.gate}: frozen`);
    expect(lines[0]).toContain("batches 2/2");
    expect(lines.at(-1)).toContain("batches 4/4");
    expect(lines.at(-1)).toContain("rows 8");
  });

  test("refusals are broken out by reason rather than lumped into a count", () => {
    const root = scratch();
    const folder = gateFolder(root, sanitizer.gate);

    mkdirSync(folder, { recursive: true });
    freezeBatch(folder, sanitizer.gate, 0, []);
    writeFileSync(join(folder, progressFile), JSON.stringify({
      started: "2026-09-23T00:00:00.000Z",
      model: "gpt-5.6-terra",
      effort: "high",
      road: "codex",
      rows: 2,
      batchSize: 2,
      shares: { calibration: 0.15, test: 0.15 },
      gates: { [sanitizer.gate]: { done: 1, sessionId: null, kept: 0, refused: { "wrong-language": 3, "too-large": 1 }, unreadable: 0, lostBatches: 0, tokens: noTokens } },
    }));

    expect(standingLines(readRunStanding(root, [sanitizer]))[0]).toContain("rows refused too-large 1, wrong-language 3");
  });
});

describe("a gate another run is already writing", () => {
  // The claim of a process that is certainly there and is certainly not this one. A writer nobody
  // here may signal is somebody else's and counts as living, which is the whole point of it.
  function claimedElsewhere(root: string, gate: string): void {
    const folder = gateFolder(root, gate);

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, ".writer.1.1"), "");
  }

  test("is refused rather than written beside", async () => {
    const root = scratch();

    claimedElsewhere(root, sanitizer.gate);

    const outcomes = await driveGates(driving(root), standIn());
    const held = outcomes.find((one) => one.gate === sanitizer.gate)!;

    expect(held.state).toBe("refused");
    expect(held.refusal).toContain("pid 1");
  });

  test("costs only itself — the other gate is written as it would have been", async () => {
    const root = scratch();

    claimedElsewhere(root, sanitizer.gate);

    const outcomes = await driveGates(driving(root), standIn());

    expect(outcomes.find((one) => one.gate === notes.gate)!.state).toBe("done");
    expect(frozenRows(root, notes.gate)).toBeGreaterThan(0);
  });

  test("has no batch bought for it", async () => {
    const root = scratch();
    const watch = { started: [] as string[], finished: [] as string[] };

    claimedElsewhere(root, sanitizer.gate);
    await driveGates(driving(root), standIn(watch));

    expect(watch.started).not.toContain(sanitizer.gate);
    expect(existsSync(join(gateFolder(root, sanitizer.gate), batchesFolder, batchName(sanitizer.gate, 0)))).toBe(false);
  });

  test("a claim its writer left behind stops nothing", async () => {
    const root = scratch();
    const folder = gateFolder(root, sanitizer.gate);

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `.writer.1.${0x7fff_ffff}`), "");

    const outcomes = await driveGates(driving(root), standIn());

    expect(outcomes.find((one) => one.gate === sanitizer.gate)!.state).toBe("done");
  });
});

describe("what a gate leaves behind when this run is done with it", () => {
  test("no claim, so the next run takes it up without waiting for anything to go stale", async () => {
    const root = scratch();

    await driveGates(driving(root), standIn());

    expect(claimsIn(gateFolder(root, sanitizer.gate))).toEqual([]);
  });

  test("a gate that fell over gives its claim up too", async () => {
    const root = scratch();
    const breaks: SynthAsker = async () => {
      throw new Error("codex did not write the batch");
    };

    const outcomes = await driveGates(driving(root, { gates: [sanitizer] }), breaks);

    expect(outcomes[0]!.state).toBe("failed");
    expect(claimsIn(gateFolder(root, sanitizer.gate))).toEqual([]);
  });
});

describe("where a run's folders stand", () => {
  test("every gate's folder is under the run's own gates folder", async () => {
    const root = scratch();

    await driveGates(driving(root), standIn());

    for (const spec of [sanitizer, notes]) {
      expect(gateFolder(root, spec.gate)).toBe(join(root, gatesFolderName, spec.gate));
      expect(existsSync(gateFolder(root, spec.gate))).toBe(true);
    }
  });
});
