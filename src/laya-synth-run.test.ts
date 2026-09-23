import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { scratchDir } from "./scratch";

import { languageBuckets, synthesisFor } from "./laya-synth";
import {
  addTokens,
  barrenAnswerName,
  batchName,
  batchPrompts,
  batchesFolder,
  freezeBatch,
  freezeSplits,
  frozenState,
  gateOnDisk,
  guardFolder,
  keepLostAnswer,
  languageFile,
  metaFile,
  noTokens,
  plannedBatches,
  progressFile,
  readFrozenBatches,
  readProgress,
  roadHoldsSession,
  lostAnswerName,
  mendedAnswerName,
  runSynthesis,
  synthRun,
} from "./laya-synth-run";
import { splitFiles, whatStands } from "./laya-frozen";

import type { GateSynthesis, LanguageBucket, SynthAsk, SynthRow } from "./laya-synth";
import type { SynthAnswer, SynthAsker, SynthMeta } from "./laya-synth-run";

// Asked for at the one door, which registers its removal as it hands it over.
function scratch(): string {
  return scratchDir("bmo-laya-synth-");
}

function gate(name: string): GateSynthesis {
  const found = synthesisFor(name);

  if (found === null) {
    throw new Error(`no gate ${name}`);
  }

  return found;
}

// The sanitiser's state is a free string with no transcript in it, so a stand-in can write one in
// whichever of the three languages a batch asked for without inventing a line shape.
const sanitizer = gate("sanitizer");

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

function rowsFor(ask: SynthAsk, count: number): SynthRow[] {
  return Array.from({ length: count }, (_, index) => ({
    state: textFor(ask.language, `${ask.seed}-${index}`),
    questions: JSON.parse(JSON.stringify(sanitizer.example.questions)) as SynthRow["questions"],
    gold: JSON.parse(JSON.stringify(sanitizer.example.gold)) as SynthRow["gold"],
  }));
}

function standIn(onAsk?: (ask: SynthAsk) => void): SynthAsker {
  return async (spec, ask) => {
    onAsk?.(ask);

    return {
      text: JSON.stringify(rowsFor(ask, ask.count)),
      sessionId: `session-${spec.gate}`,
      tokens: { inputTokens: 100, outputTokens: 400, cacheReadTokens: 900, cacheWriteTokens: 50 },
    } satisfies SynthAnswer;
  };
}

const options = (folder: string, extra: Partial<Parameters<typeof runSynthesis>[0]> = {}) => ({
  folder,
  gates: [sanitizer],
  rows: 6,
  batchSize: 2,
  model: "claude-opus-5",
  effort: "medium",
  road: "claude" as const,
  shares: { calibration: 0.15, test: 0.15 },
  resume: false,
  ...extra,
});

describe("the run one batch is", () => {
  test("holds its session, unlike a one-shot judgement", () => {
    const run = synthRun("claude-opus-5", "medium", "/prompts/x.md", "묶음", null, "/cwd", {});

    expect(run.keepSession).toBe(true);
    expect(run.resumeSessionId).toBeNull();
  });

  test("carries the session the last batch came back with", () => {
    expect(synthRun("m", "medium", "/p.md", "묶음", "abc123", "/cwd", {}).resumeSessionId).toBe("abc123");
  });

  test("asks for no tools and the harness's own commands stay off", () => {
    const run = synthRun("m", "medium", "/p.md", "묶음", null, "/cwd", {});

    expect(run.toolsShown).toBe("");
    expect(run.hostCommands).toBe(false);
  });

  test("the gate's fixed prefix is the system prompt and the batch's ask is the prompt", () => {
    const first = batchPrompts(sanitizer, plannedBatches(sanitizer, 4, 2)[0]!);
    const second = batchPrompts(sanitizer, plannedBatches(sanitizer, 4, 2)[1]!);

    expect(second.system).toBe(first.system);
    expect(second.prompt).not.toBe(first.prompt);
  });
});

describe("which road holds a session", () => {
  test("the Claude road does and J3090 does not", () => {
    expect(roadHoldsSession("claude")).toBe(true);
    expect(roadHoldsSession("j3090")).toBe(false);
  });
});

describe("the batch plan", () => {
  test("is the same plan every time it is drawn", () => {
    expect(plannedBatches(sanitizer, 100, 20)).toEqual(plannedBatches(sanitizer, 100, 20));
  });

  test("asks for exactly the rows wanted", () => {
    const plan = plannedBatches(sanitizer, 47, 20);

    expect(plan.reduce((sum, ask) => sum + ask.count, 0)).toBe(47);
    expect(plan).toHaveLength(3);
  });

  test("draws the languages to the gate's own mix", () => {
    const plan = plannedBatches(sanitizer, 2_000, 10);
    const counted = Object.fromEntries(languageBuckets.map((bucket) => [
      bucket,
      plan.filter((ask) => ask.language === bucket).length / plan.length,
    ])) as Record<LanguageBucket, number>;

    for (const bucket of languageBuckets) {
      expect(Math.abs(counted[bucket] - sanitizer.language[bucket])).toBeLessThan(0.05);
    }
  });

  test("interleaves the languages rather than writing them in blocks", () => {
    const first = plannedBatches(sanitizer, 400, 10).slice(0, 12).map((ask) => ask.language);

    expect(new Set(first).size).toBeGreaterThan(1);
  });

  test("leans on each answer in turn, so the balance is drawn rather than hoped for", () => {
    const plan = plannedBatches(sanitizer, 200, 10);
    const trues = plan.filter((ask) => ask.lean === true).length;

    expect(trues).toBe(plan.length - trues);
  });

  test("a choice gate leans on each of its four options", () => {
    const plan = plannedBatches(gate("knowledge-classifier"), 400, 10);

    expect(new Set(plan.map((ask) => ask.lean))).toEqual(new Set(["universal", "personal", "room", "none"]));
  });

  test("each answer gets its own share of the languages, so losing one language cannot cost one answer every row", () => {
    // Five batches is where the two lined up before: the answers alternate by parity and the
    // languages fell the same way, so every batch of one answer took one language.
    for (const batches of [4, 5, 6, 8, 10]) {
      const plan = plannedBatches(sanitizer, batches * 10, 10);
      const byLean = new Map<string, Set<string>>();

      for (const ask of plan) {
        const held = byLean.get(String(ask.lean)) ?? new Set<string>();

        held.add(ask.language);
        byLean.set(String(ask.lean), held);
      }

      // Every answer keeps at least one batch in the language the gate is mostly drawn to, so
      // losing a minority language costs each answer some rows and never all of them.
      const majority = languageBuckets.reduce((best, one) => sanitizer.language[one] > sanitizer.language[best] ? one : best);
      const without = [...byLean.entries()].filter(([, seen]) => !seen.has(majority)).map(([lean]) => lean);

      expect({ batches, without }).toEqual({ batches, without: [] });
    }
  });

  test("carries all three room kinds and a share of edge batches", () => {
    const plan = plannedBatches(sanitizer, 300, 10);

    expect(new Set(plan.map((ask) => ask.room))).toEqual(new Set(["owner", "group", "ai"]));
    expect(plan.filter((ask) => ask.edge).length).toBeGreaterThan(plan.length / 4);
  });
});

describe("the folder guard", () => {
  test("lets an empty folder through", () => {
    expect(guardFolder(scratch(), { resume: false, overwrite: false })).toBeNull();
  });

  test("refuses a folder that already holds a frozen dataset, and names what stands there", () => {
    const folder = scratch();

    writeFileSync(join(folder, splitFiles.train), '{"id":"a"}\n{"id":"b"}\n');

    const refusal = guardFolder(folder, { resume: false, overwrite: false });

    expect(refusal).toContain(folder);
    expect(refusal).toContain("train.jsonl (2행)");
    expect(refusal).toContain("--overwrite");
  });

  test("lets it through when the run says outright that it means to", () => {
    const folder = scratch();

    writeFileSync(join(folder, splitFiles.train), "{}\n");

    expect(guardFolder(folder, { resume: false, overwrite: true })).toBeNull();
  });

  test("refuses a half-written run and offers both ways out", () => {
    const folder = scratch();

    writeFileSync(join(folder, progressFile), "{}");

    const refusal = guardFolder(folder, { resume: false, overwrite: false });

    expect(refusal).toContain("--resume");
    expect(refusal).toContain("--overwrite");
  });

  test("lets a half-written run be resumed", () => {
    const folder = scratch();

    writeFileSync(join(folder, progressFile), "{}");

    expect(guardFolder(folder, { resume: true, overwrite: false })).toBeNull();
  });

  test("reads the state of a folder", () => {
    const folder = scratch();

    expect(frozenState(folder)).toBe("empty");

    writeFileSync(join(folder, progressFile), "{}");
    expect(frozenState(folder)).toBe("in-progress");

    writeFileSync(join(folder, splitFiles.test), "");
    expect(frozenState(folder)).toBe("frozen");
  });

  test("what stands in a folder counts the rows of a file that has them", () => {
    const folder = scratch();

    writeFileSync(join(folder, splitFiles.calibration), "{}\n{}\n{}\n");

    expect(whatStands(folder)).toEqual(["calibration.jsonl (3행)"]);
  });
});

describe("a whole run against a stand-in", () => {
  test("freezes the three files, the meta and the language sidecar", async () => {
    const folder = scratch();
    const report = await runSynthesis(options(folder), standIn());

    for (const name of Object.values(splitFiles)) {
      expect(existsSync(join(folder, name))).toBe(true);
    }

    expect(existsSync(join(folder, metaFile))).toBe(true);
    expect(existsSync(join(folder, languageFile))).toBe(true);
    expect(report.asked).toBe(3);
    expect(report.meta.gates[0]!.rows).toBe(6);
  });

  test("the sidecar names every frozen row's language, since a DatasetRow has nowhere to put it", async () => {
    const folder = scratch();

    await runSynthesis(options(folder), standIn());

    const ids = Object.values(splitFiles).flatMap((name) =>
      readFileSync(join(folder, name), "utf8").split("\n").filter((line) => line.trim() !== "")
        .map((line) => (JSON.parse(line) as { id: string }).id));
    const sidecar = readFileSync(join(folder, languageFile), "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { id: string; language: LanguageBucket });

    expect(sidecar).toHaveLength(ids.length);
    expect(new Set(sidecar.map((one) => one.id))).toEqual(new Set(ids));

    for (const one of sidecar) {
      expect(languageBuckets).toContain(one.language);
    }
  });

  test("the meta says which model wrote it, when, and what each gate came to", async () => {
    const folder = scratch();

    await runSynthesis(options(folder), standIn());

    const meta = JSON.parse(readFileSync(join(folder, metaFile), "utf8")) as SynthMeta;

    expect(meta.model).toBe("claude-opus-5");
    expect(meta.effort).toBe("medium");
    expect(meta.road).toBe("claude");
    expect(Date.parse(meta.written)).toBeGreaterThan(0);
    expect(Date.parse(meta.started)).toBeGreaterThan(0);
    expect(meta.gates.map((one) => one.gate)).toEqual(["sanitizer"]);
  });

  test("the cache read is kept apart from the new input", async () => {
    const folder = scratch();

    await runSynthesis(options(folder), standIn());

    const meta = JSON.parse(readFileSync(join(folder, metaFile), "utf8")) as SynthMeta;

    expect(meta.tokens.cacheReadTokens).toBe(2_700);
    expect(meta.tokens.inputTokens).toBe(300);
    expect(meta.gates[0]!.tokens.cacheWriteTokens).toBe(150);
  });

  test("a row the validator refuses is counted and not frozen", async () => {
    const folder = scratch();
    // Every batch is written in Korean whatever the batch asked for, so the batches that asked for
    // another language are refused outright.
    const report = await runSynthesis(options(folder, { rows: 20, batchSize: 1 }), async (spec, ask) => ({
      text: JSON.stringify(rowsFor({ ...ask, language: "korean" }, ask.count)),
      sessionId: "s",
      tokens: noTokens,
    }));

    expect(report.meta.gates[0]!.refused["wrong-language"]).toBeGreaterThan(0);
    expect(report.meta.gates[0]!.rows).toBeLessThan(20);
  });

  test("an answer that is not rows at all is counted unreadable", async () => {
    const folder = scratch();
    const report = await runSynthesis(options(folder), async () => ({
      text: JSON.stringify([{ state: "안녕" }, { state: "안녕" }]),
      sessionId: "s",
      tokens: noTokens,
    }));

    expect(report.meta.gates[0]!.unreadable).toBe(6);
    expect(report.meta.gates[0]!.rows).toBe(0);
  });

  test("the same input landing in two batches is frozen once and counted as a duplicate", async () => {
    const folder = scratch();

    await runSynthesis(options(folder), standIn());

    const progress = readProgress(folder)!;
    const already = readFrozenBatches(folder);

    // The same rows land again in a batch of their own, which is what a model repeating itself
    // across two batches of one gate comes to.
    freezeBatch(folder, "sanitizer", 99, already);

    const meta = freezeSplits(folder, progress);

    expect(meta.gates[0]!.rows).toBe(already.length);
    expect(meta.gates[0]!.duplicates).toBe(already.length);
  });

  test("the language and the balance reached are written down beside what was asked for", async () => {
    const folder = scratch();
    const report = await runSynthesis(options(folder, { rows: 60, batchSize: 2 }), standIn());
    const figures = report.meta.gates[0]!;
    const languages = Object.values(figures.language).reduce((sum, one) => sum + one, 0);

    expect(Math.abs(languages - 1)).toBeLessThan(0.01);
    expect(Object.keys(figures.balance)).toEqual(["false"]);
    expect(figures.balance.false).toBe(1);
  });
});

describe("the J3090 road", () => {
  test("says outright that it held no session and reused no cache", async () => {
    const folder = scratch();
    const report = await runSynthesis(options(folder, { road: "j3090", model: "qwen3.8-27b" }), standIn());

    expect(report.meta.sessionHeld).toBe(false);
    expect(report.meta.cacheReused).toBe(false);
    expect(report.meta.gates[0]!.sessionHeld).toBe(false);
  });

  test("is never handed a session to resume", async () => {
    const folder = scratch();
    const resumed: (string | null)[] = [];

    await runSynthesis(options(folder, { road: "j3090" }), async (spec, ask, sessionId) => {
      resumed.push(sessionId);

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "ignored", tokens: noTokens };
    });

    expect(resumed).toEqual([null, null, null]);
  });

  test("the Claude road carries the last batch's session into the next", async () => {
    const folder = scratch();
    const resumed: (string | null)[] = [];

    await runSynthesis(options(folder), async (spec, ask, sessionId) => {
      resumed.push(sessionId);

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "held-1", tokens: noTokens };
    });

    expect(resumed).toEqual([null, "held-1", "held-1"]);
  });

  test("the run says so out loud before it starts", async () => {
    const folder = scratch();
    const said: string[] = [];

    await runSynthesis(options(folder, { road: "j3090", say: (line: string) => said.push(line) }), standIn());

    expect(said[0]).toContain("세션을 붙들지 않습니다");
  });
});

describe("a run that dies", () => {
  test("keeps what it had frozen up to the batch before", async () => {
    const folder = scratch();

    await expect(runSynthesis(options(folder), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("세션이 끊겼습니다");
      }

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "held", tokens: noTokens };
    })).rejects.toThrow("세션이 끊겼습니다");

    expect(readProgress(folder)!.gates.sanitizer!.done).toBe(2);
    expect(readFrozenBatches(folder)).toHaveLength(4);
    expect(frozenState(folder)).toBe("in-progress");
  });

  test("takes up where it left off instead of starting again", async () => {
    const folder = scratch();

    await expect(runSynthesis(options(folder), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("세션이 끊겼습니다");
      }

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "held", tokens: noTokens };
    })).rejects.toThrow();

    const seeds: string[] = [];
    const report = await runSynthesis(options(folder, { resume: true }), standIn((ask) => seeds.push(ask.seed)));

    expect(seeds).toEqual(["sanitizer-3"]);
    expect(report.asked).toBe(1);
    expect(report.meta.gates[0]!.rows).toBe(6);
  });

  test("resuming carries the session the dead run was riding", async () => {
    const folder = scratch();

    await expect(runSynthesis(options(folder), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("끊김");
      }

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "held-9", tokens: noTokens };
    })).rejects.toThrow();

    const resumed: (string | null)[] = [];

    await runSynthesis(options(folder, { resume: true }), async (spec, ask, sessionId) => {
      resumed.push(sessionId);

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "held-9", tokens: noTokens };
    });

    expect(resumed).toEqual(["held-9"]);
  });

  test("the tokens the dead run spent are still counted in the meta", async () => {
    const folder = scratch();

    await expect(runSynthesis(options(folder), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("끊김");
      }

      return {
        text: JSON.stringify(rowsFor(ask, ask.count)),
        sessionId: "held",
        tokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      };
    })).rejects.toThrow();

    const report = await runSynthesis(options(folder, { resume: true }), standIn());

    expect(report.meta.gates[0]!.tokens.cacheReadTokens).toBe(30 + 30 + 900);
  });
});

describe("resuming a gate onto a different road", () => {
  // A gate started on codex and stopped, taken up on J3090 — the shape of moving sanitizer off the
  // road its rows are refused on, without rebuilding what codex already wrote.
  async function stoppedOnCodex(folder: string): Promise<void> {
    await expect(runSynthesis(options(folder, { road: "codex", model: "gpt-5.6-terra", effort: "high" }), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("codex refused");
      }

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "codex-thread", tokens: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 0 } };
    })).rejects.toThrow();
  }

  test("the frozen batches stand and only the rest are asked for on the new road", async () => {
    const folder = scratch();

    await stoppedOnCodex(folder);

    const seeds: string[] = [];
    const report = await runSynthesis(options(folder, { resume: true, road: "j3090", model: "qwen3.8-27b", effort: "none" }), standIn((ask) => seeds.push(ask.seed)));

    expect(seeds).toEqual(["sanitizer-3"]);
    expect(report.meta.gates[0]!.rows).toBe(6);
  });

  test("both roads are recorded, the one now driving is the road", async () => {
    const folder = scratch();

    await stoppedOnCodex(folder);

    const report = await runSynthesis(options(folder, { resume: true, road: "j3090", model: "qwen3.8-27b", effort: "none" }), standIn());

    expect(report.meta.road).toBe("j3090");
    expect(report.meta.roads).toEqual(["codex", "j3090"]);
    expect(report.meta.model).toBe("qwen3.8-27b");
  });

  test("the new road is never handed the dead road's session", async () => {
    const folder = scratch();

    await stoppedOnCodex(folder);

    const resumed: (string | null)[] = [];

    await runSynthesis(options(folder, { resume: true, road: "j3090", model: "qwen3.8-27b" }), async (spec, ask, sessionId) => {
      resumed.push(sessionId);

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: null, tokens: noTokens };
    });

    expect(resumed).toEqual([null]);
  });

  test("a resume on the same road keeps that one road", async () => {
    const folder = scratch();

    await expect(runSynthesis(options(folder, { road: "codex", model: "gpt-5.6-terra" }), async (spec, ask) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("끊김");
      }

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "codex-thread", tokens: noTokens };
    })).rejects.toThrow();

    const report = await runSynthesis(options(folder, { resume: true, road: "codex", model: "gpt-5.6-terra" }), standIn());

    expect(report.meta.roads).toEqual(["codex"]);
  });
});

describe("a batch that read and kept nothing", () => {
  // A row-shaped thing the gate will refuse outright: it reads as a row, so the batch is not lost,
  // and it survives nothing, so the batch freezes empty.
  const refusable = JSON.stringify([{ state: "   ", questions: {}, gold: {} }]);

  test("the answer is kept, because a gate that comes back empty has to be answerable for", async () => {
    const folder = scratch();

    await runSynthesis(options(folder, { rows: 2, batchSize: 2 }), async () => ({
      text: refusable,
      sessionId: "held",
      tokens: noTokens,
    }));

    expect(existsSync(join(folder, batchesFolder, barrenAnswerName("sanitizer", 0)))).toBe(true);
    expect(readFileSync(join(folder, batchesFolder, barrenAnswerName("sanitizer", 0)), "utf8")).toBe(refusable);
  });

  test("it is not counted as a lost batch, because nothing was lost", async () => {
    const folder = scratch();

    await runSynthesis(options(folder, { rows: 2, batchSize: 2 }), async () => ({
      text: refusable,
      sessionId: "held",
      tokens: noTokens,
    }));

    expect(readProgress(folder)!.gates.sanitizer!.lostBatches).toBe(0);
    expect(existsSync(join(folder, batchesFolder, lostAnswerName("sanitizer", 0)))).toBe(false);
  });

  test("a batch that kept something keeps no answer beside it", async () => {
    const folder = scratch();

    await runSynthesis(options(folder, { rows: 2, batchSize: 2 }), standIn());

    expect(existsSync(join(folder, batchesFolder, barrenAnswerName("sanitizer", 0)))).toBe(false);
  });
});

describe("a batch whose list came back broken", () => {
  // Every row closes correctly and one brace too many follows it, so the list is not whole while
  // the rows inside it are perfectly good.
  function oneTooMany(ask: SynthAsk): string {
    return `[${rowsFor(ask, ask.count).map((row) => `${JSON.stringify(row)}}`).join(",")}]`;
  }

  test("the rows are read out one at a time rather than the batch being thrown away", async () => {
    const folder = scratch();

    const report = await runSynthesis(options(folder, { rows: 2, batchSize: 2 }), async (spec, ask) => ({
      text: oneTooMany(ask),
      sessionId: "held",
      tokens: noTokens,
    }));

    expect(report.meta.gates[0]!.rows).toBe(2);
    expect(report.meta.gates[0]!.lostBatches).toBe(0);
  });

  test("the answer is kept and said, so a gate mending every batch is visible", async () => {
    const folder = scratch();

    await runSynthesis(options(folder, { rows: 2, batchSize: 2 }), async (spec, ask) => ({
      text: oneTooMany(ask),
      sessionId: "held",
      tokens: noTokens,
    }));

    expect(existsSync(join(folder, batchesFolder, mendedAnswerName("sanitizer", 0)))).toBe(true);
    expect(readProgress(folder)!.gates.sanitizer!.mendedBatches).toBe(1);
  });
});

describe("a batch nothing could be read out of", () => {
  test("is counted and leaves its answer beside the batch it should have been", async () => {
    const folder = scratch();

    await runSynthesis(options(folder, { rows: 2, batchSize: 2 }), async () => ({
      text: "만들지 못했습니다. 다시 시도해 주세요.",
      sessionId: "s",
      tokens: noTokens,
    }));

    const kept = join(folder, "batches", lostAnswerName("sanitizer", 0));

    expect(existsSync(kept)).toBe(true);
    expect(readFileSync(kept, "utf8")).toContain("만들지 못했습니다");
    expect(readProgress(folder)!.gates.sanitizer!.lostBatches).toBe(1);
  });

  test("a batch that read fine leaves no such file", async () => {
    const folder = scratch();

    await runSynthesis(options(folder, { rows: 2, batchSize: 2 }), standIn());

    expect(existsSync(join(folder, "batches", lostAnswerName("sanitizer", 0)))).toBe(false);
  });
});

describe("freezing what landed", () => {
  test("a batch is on disk the moment it lands", async () => {
    const folder = scratch();
    let seen = 0;

    await runSynthesis(options(folder), async (spec, ask) => {
      seen = readFrozenBatches(folder).length;

      return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "s", tokens: noTokens };
    });

    // The third ask sees the two batches that landed before it.
    expect(seen).toBe(4);
  });

  test("a batch with nothing in it still marks its place", () => {
    const folder = scratch();

    freezeBatch(folder, "sanitizer", 0, []);

    expect(readFrozenBatches(folder)).toEqual([]);
    expect(existsSync(join(folder, "batches", "sanitizer-0001.jsonl"))).toBe(true);
  });

  test("the batches are read back in the order they were written", () => {
    const folder = scratch();

    mkdirSync(join(folder, "batches"), { recursive: true });

    for (let index = 0; index < 12; index += 1) {
      freezeBatch(folder, "sanitizer", index, [{
        row: { id: `sanitizer:${index}`, gate: "sanitizer", split: "train", state: "{}", questions: "{}", gold: "{}" },
        language: "korean",
      }]);
    }

    expect(readFrozenBatches(folder).map((one) => one.row.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `sanitizer:${index}`),
    );
  });

  test("freezing twice over the same batches writes the same rows", async () => {
    const folder = scratch();

    await runSynthesis(options(folder), standIn());

    const once = readFileSync(join(folder, splitFiles.train), "utf8");

    freezeSplits(folder, readProgress(folder)!);

    expect(readFileSync(join(folder, splitFiles.train), "utf8")).toBe(once);
  });
});

describe("the token tally", () => {
  test("adds two tallies field by field", () => {
    expect(addTokens(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    )).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
  });

  test("an empty tally adds nothing", () => {
    const one = { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 };

    expect(addTokens(one, noTokens)).toEqual(one);
  });
});

// The window a run can be killed in that its own record does not survive: the batch is frozen,
// and the count saying so has not been written yet. The kill is made by taking the progress file's
// name away — a directory stands where the file goes, so the write onto it cannot land — which
// puts the run down inside that window through the code that really runs rather than by arranging
// the leavings by hand.
function blockProgress(folder: string): void {
  mkdirSync(join(folder, progressFile), { recursive: true });
}

describe("a run killed between freezing a batch and recording it", () => {
  test("does not ask the model for that batch again", async () => {
    const folder = scratch();

    blockProgress(folder);

    await expect(runSynthesis(options(folder), standIn())).rejects.toThrow();

    expect(existsSync(join(folder, batchesFolder, batchName("sanitizer", 0)))).toBe(true);

    rmSync(join(folder, progressFile), { recursive: true });

    const seeds: string[] = [];

    await runSynthesis(options(folder, { resume: true }), standIn((ask) => seeds.push(ask.seed)));

    expect(seeds).toEqual(["sanitizer-2", "sanitizer-3"]);
  });

  test("a write that cannot land leaves nothing half-written behind it", async () => {
    const folder = scratch();

    blockProgress(folder);

    await expect(runSynthesis(options(folder), standIn())).rejects.toThrow();

    expect(readdirSync(folder).filter((name) => name.endsWith(".writing"))).toEqual([]);
  });
});

// The same window, reached on a batch that is not the first. Here the dead run did record the
// batches before, so its count survives it and is one behind the batches standing in the folder —
// which is the whole signature of the window, and the only state a run left in it can be in. The
// count is wound back by hand because nothing else about a run killed there differs, and the run
// up to that point is a real one.
async function killedAfterFreezingBatch(folder: string, index: number): Promise<void> {
  await expect(runSynthesis(options(folder), async (spec, ask) => {
    if (ask.seed.endsWith(`-${index + 2}`)) {
      throw new Error("세션이 끊겼습니다");
    }

    return { text: JSON.stringify(rowsFor(ask, ask.count)), sessionId: "held", tokens: noTokens };
  })).rejects.toThrow();

  const progress = readProgress(folder)!;

  progress.gates.sanitizer!.done = index;
  writeFileSync(join(folder, progressFile), `${JSON.stringify(progress, null, 2)}\n`);
}

// Rows a resumed run writes that the dead one could not have, so a batch written over is a batch
// that reads differently afterwards rather than one that happens to come back the same.
function secondPass(onAsk?: (ask: SynthAsk) => void): SynthAsker {
  return async (spec, ask) => {
    onAsk?.(ask);

    return {
      text: JSON.stringify(rowsFor(ask, ask.count).map((row) => ({ ...row, state: `${row.state} 두 번째` }))),
      sessionId: "held",
      tokens: noTokens,
    } satisfies SynthAnswer;
  };
}

describe("a run killed there on a batch that is not its first", () => {
  test("the batch its count never caught up with is not asked for again", async () => {
    const folder = scratch();

    await killedAfterFreezingBatch(folder, 1);

    const seeds: string[] = [];

    await runSynthesis(options(folder, { resume: true }), secondPass((ask) => seeds.push(ask.seed)));

    expect(seeds).toEqual(["sanitizer-3"]);
  });

  test("that batch's rows stand as they were rather than being written over", async () => {
    const folder = scratch();

    await killedAfterFreezingBatch(folder, 1);

    const landed = join(folder, batchesFolder, batchName("sanitizer", 1));
    const before = readFileSync(landed, "utf8");

    await runSynthesis(options(folder, { resume: true }), secondPass());

    expect(readFileSync(landed, "utf8")).toBe(before);
    expect(readFileSync(landed, "utf8")).not.toContain("두 번째");
  });

  test("the rows it kept are counted off the batches, not off the count that lost them", async () => {
    const folder = scratch();

    await killedAfterFreezingBatch(folder, 1);

    const report = await runSynthesis(options(folder, { resume: true }), secondPass());

    // Six rows in batches of two. A run that asked the second batch over again would count its
    // rows twice and report eight against the six that are really there.
    expect(report.meta.gates[0]!.kept).toBe(6);
    expect(report.meta.gates[0]!.rows).toBe(6);
  });
});

describe("how far a gate got, read off the folder", () => {
  test("an untouched folder has nothing standing in it", () => {
    expect(gateOnDisk(scratch(), "sanitizer", 3)).toEqual({ done: 0, kept: 0, lost: 0 });
  });

  test("counts the batches that stand and the rows in them", () => {
    const folder = scratch();

    freezeBatch(folder, "sanitizer", 0, [
      { row: { id: "a", gate: "sanitizer", split: "train", state: "{}", questions: "{}", gold: "{}" }, language: "korean" },
      { row: { id: "b", gate: "sanitizer", split: "train", state: "{}", questions: "{}", gold: "{}" }, language: "korean" },
    ]);
    freezeBatch(folder, "sanitizer", 1, [
      { row: { id: "c", gate: "sanitizer", split: "test", state: "{}", questions: "{}", gold: "{}" }, language: "english" },
    ]);

    expect(gateOnDisk(folder, "sanitizer", 4)).toEqual({ done: 2, kept: 3, lost: 0 });
  });

  test("a batch that kept nothing still counts as done", () => {
    const folder = scratch();

    freezeBatch(folder, "sanitizer", 0, []);

    expect(gateOnDisk(folder, "sanitizer", 3)).toEqual({ done: 1, kept: 0, lost: 0 });
  });

  test("a lost answer beside a batch is counted with it", () => {
    const folder = scratch();

    freezeBatch(folder, "sanitizer", 0, []);
    keepLostAnswer(folder, "sanitizer", 0, "여기엔 행 목록이 없습니다");

    expect(gateOnDisk(folder, "sanitizer", 3)).toEqual({ done: 1, kept: 0, lost: 1 });
  });

  test("it stops at the first batch that is missing rather than counting the files", () => {
    const folder = scratch();

    freezeBatch(folder, "sanitizer", 0, []);
    freezeBatch(folder, "sanitizer", 2, []);

    expect(gateOnDisk(folder, "sanitizer", 4).done).toBe(1);
  });

  test("another gate's batches in the same folder are not this gate's", () => {
    const folder = scratch();

    freezeBatch(folder, "reply-wanted", 0, []);

    expect(gateOnDisk(folder, "sanitizer", 3).done).toBe(0);
  });

  test("it never counts past the plan it was given", () => {
    const folder = scratch();

    freezeBatch(folder, "sanitizer", 0, []);
    freezeBatch(folder, "sanitizer", 1, []);

    expect(gateOnDisk(folder, "sanitizer", 1).done).toBe(1);
  });
});
