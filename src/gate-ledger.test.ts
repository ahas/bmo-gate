import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { driveGates } from "./gate-run";
import { ledgerLines, noPriceHere, readLedger } from "./gate-ledger";
import { gateFolder } from "./roots";
import { metaFile } from "./laya-synth-run";
import { synthesisFor } from "./laya-synth";
import { scratchDir } from "./scratch";

import type { GateSynthesis, LanguageBucket, SynthAsk, SynthRow } from "./laya-synth";
import type { SynthAsker, SynthMeta } from "./laya-synth-run";

function scratch(): string {
  return scratchDir("bmo-gate-ledger-");
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

  return typeof spec.example.state === "string" ? said : { ...(spec.example.state as Record<string, unknown>), note: said };
}

function rowsFor(spec: GateSynthesis, ask: SynthAsk, count: number): SynthRow[] {
  return Array.from({ length: count }, (_, index) => ({
    state: stateFor(spec, ask.language, `${ask.seed}-${index}`),
    questions: JSON.parse(JSON.stringify(spec.example.questions)) as SynthRow["questions"],
    gold: JSON.parse(JSON.stringify(spec.example.gold)) as SynthRow["gold"],
  }));
}

// Every batch carries one row the gate will refuse, so the ledger has a written count larger than
// its kept count and a refusal to break out by reason — which is what it is for.
const standIn: SynthAsker = async (spec, ask) => ({
  text: JSON.stringify([
    ...rowsFor(spec, ask, ask.count),
    { ...rowsFor(spec, ask, 1)[0]!, questions: {}, gold: {} },
  ]),
  sessionId: `thread-${spec.gate}`,
  tokens: { inputTokens: 90, outputTokens: 400, cacheReadTokens: 11_008, cacheWriteTokens: 5 },
});

async function runOf(gates: readonly GateSynthesis[], rows = 20): Promise<string> {
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

describe("the ledger for a run", () => {
  test("has a row for every gate that ran", async () => {
    const ledger = readLedger(await runOf([sanitizer, notes]), [sanitizer, notes]);

    expect(typeof ledger === "string" ? [] : ledger.gates.map((one) => one.gate).sort())
      .toEqual([notes.gate, sanitizer.gate].sort());
  });

  test("a gate that never started is left out, not entered as a row of zeroes", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer, notes]);

    expect(typeof ledger === "string" ? [] : ledger.gates.map((one) => one.gate)).toEqual([sanitizer.gate]);
  });

  test("a run where nothing started says so rather than reading as an empty ledger", () => {
    expect(readLedger(scratch(), [sanitizer])).toContain("아직 아무 게이트도 시작하지 않았습니다");
  });

  test("it names the model, the effort and the road", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);

    expect(ledger).toMatchObject({ models: [{ model: "gpt-5.6-terra", effort: "high" }], roads: ["codex"] });
  });

  // A run whose gates did not share a road did not share a model either, and naming one of them as
  // the run's would put the other gate's rows under a model that never wrote them.
  test("it names every model its gates were written with, once each", async () => {
    const root = await runOf([sanitizer, notes]);

    await driveGates({
      root,
      gates: [sanitizer],
      rows: 40,
      batchSize: 5,
      model: "qwen3.8-27b",
      effort: "none",
      road: "j3090",
      shares: { calibration: 0.15, test: 0.15 },
      atOnce: 1,
      resume: true,
      overwrite: true,
    }, standIn);

    const ledger = readLedger(root, [sanitizer, notes]);

    expect(typeof ledger === "string" ? null : ledger.models)
      .toEqual([{ model: "qwen3.8-27b", effort: "none" }, { model: "gpt-5.6-terra", effort: "high" }]);
    expect(typeof ledger === "string" ? null : ledger.roads).toEqual(["codex", "j3090"]);
  });
});

describe("what the ledger records of a gate", () => {
  test("rows written and rows kept are both there, and they differ", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);
    const one = typeof ledger === "string" ? null : ledger.gates[0]!;

    // Four batches of five, each carrying one row the gate refuses.
    expect(one!.written).toBe(24);
    expect(one!.kept).toBe(20);
  });

  test("the three split counts add up to the rows kept", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);
    const one = typeof ledger === "string" ? null : ledger.gates[0]!;

    expect(one!.splits.train + one!.splits.calibration + one!.splits.test).toBe(one!.kept);
  });

  test("batches done against planned are both there", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);

    expect(typeof ledger === "string" ? null : ledger.gates[0]).toMatchObject({ batchesDone: 4, batchesPlanned: 4 });
  });

  test("refusals are broken out by reason rather than lumped into a count", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);
    const one = typeof ledger === "string" ? null : ledger.gates[0]!;

    expect(Object.keys(one!.refused)).toEqual(["no-questions"]);
    expect(one!.refused["no-questions"]).toBe(4);
  });

  // The meta is written at freezing, and a gate is a day's writing away from that. Until then its
  // progress is the account of what is writing it, and the ledger is read off that.
  test("a gate that has not frozen still names its road and its model", async () => {
    const root = scratch();

    await driveGates({
      root,
      gates: [sanitizer],
      rows: 20,
      batchSize: 5,
      model: "qwen3.8-27b",
      effort: "none",
      road: "j3090",
      shares: { calibration: 0.15, test: 0.15 },
      atOnce: 1,
      resume: false,
      overwrite: false,
    }, async (spec, ask, resume) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("세션이 끊겼습니다");
      }

      return standIn(spec, ask, resume);
    });

    const ledger = readLedger(root, [sanitizer]);

    expect(typeof ledger === "string" ? null : ledger.gates[0])
      .toMatchObject({ roads: ["j3090"], model: "qwen3.8-27b", effort: "none", threadHeld: false });
    expect(typeof ledger === "string" ? null : ledger.models).toEqual([{ model: "qwen3.8-27b", effort: "none" }]);
  });

  test("a lost batch is counted", async () => {
    const root = scratch();

    await driveGates({
      root,
      gates: [sanitizer],
      rows: 10,
      batchSize: 5,
      model: "gpt-5.6-terra",
      effort: "high",
      shares: { calibration: 0.15, test: 0.15 },
      atOnce: 1,
      resume: false,
      overwrite: false,
    }, async () => ({ text: "행 목록이 아니라 그냥 할 말", sessionId: "held", tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }));

    expect(typeof readLedger(root, [sanitizer]) === "string" ? null : (readLedger(root, [sanitizer]) as { gates: { lostBatches: number }[] }).gates[0])
      .toMatchObject({ lostBatches: 2 });
  });

  test("fresh input and cache reads stand apart", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);
    const one = typeof ledger === "string" ? null : ledger.gates[0]!;

    // Four batches at 90 fresh and 11,008 cached each. Added together they would be one figure
    // saying nothing about whether the thread did its job.
    expect(one!.tokens.inputTokens).toBe(360);
    expect(one!.tokens.cacheReadTokens).toBe(44_032);
    expect(one!.tokens.cacheWriteTokens).toBe(20);
    expect(one!.tokens.outputTokens).toBe(1_600);
  });

  test("the thread a gate held is recorded", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);

    expect(typeof ledger === "string" ? null : ledger.gates[0]).toMatchObject({ threadHeld: true });
  });

  test("the wall time comes off the gate's own start and finish", async () => {
    const root = await runOf([sanitizer]);
    const path = join(gateFolder(root, sanitizer.gate), metaFile);
    const meta = JSON.parse(readFileSync(path, "utf8")) as SynthMeta;

    meta.started = "2026-09-23T00:00:00.000Z";
    meta.written = "2026-09-23T00:02:30.000Z";
    writeFileSync(path, JSON.stringify(meta, null, 2));

    expect(typeof readLedger(root, [sanitizer]) === "string" ? null : (readLedger(root, [sanitizer]) as { gates: { seconds: number }[] }).gates[0])
      .toMatchObject({ seconds: 150 });
  });
});

describe("the ledger's totals", () => {
  test("the rows and batches are the gates' added up", async () => {
    const ledger = readLedger(await runOf([sanitizer, notes]), [sanitizer, notes]);

    if (typeof ledger === "string") {
      throw new Error(ledger);
    }

    expect(ledger.totals.written).toBe(ledger.gates.reduce((all, one) => all + one.written, 0));
    expect(ledger.totals.kept).toBe(ledger.gates.reduce((all, one) => all + one.kept, 0));
    expect(ledger.totals.batchesDone).toBe(ledger.gates.reduce((all, one) => all + one.batchesDone, 0));
  });

  test("the tokens are the gates' added up, field by field", async () => {
    const ledger = readLedger(await runOf([sanitizer, notes]), [sanitizer, notes]);

    if (typeof ledger === "string") {
      throw new Error(ledger);
    }

    expect(ledger.totals.tokens.cacheReadTokens).toBe(ledger.gates.reduce((all, one) => all + one.tokens.cacheReadTokens, 0));
    expect(ledger.totals.tokens.inputTokens).toBe(ledger.gates.reduce((all, one) => all + one.tokens.inputTokens, 0));
  });

  test("the run's wall time is the run's, not the gates' times added together", async () => {
    const root = await runOf([sanitizer, notes]);

    for (const [spec, from, to] of [[sanitizer, "2026-09-23T00:00:00.000Z", "2026-09-23T01:00:00.000Z"], [notes, "2026-09-23T00:00:00.000Z", "2026-09-23T01:00:00.000Z"]] as const) {
      const path = join(gateFolder(root, spec.gate), metaFile);
      const meta = JSON.parse(readFileSync(path, "utf8")) as SynthMeta;

      meta.started = from;
      meta.written = to;
      writeFileSync(path, JSON.stringify(meta, null, 2));
    }

    const ledger = readLedger(root, [sanitizer, notes]);

    if (typeof ledger === "string") {
      throw new Error(ledger);
    }

    // Two gates of an hour each, written beside each other, is an hour — not two.
    expect(ledger.totals.seconds).toBe(3_600);
    expect(ledger.gates.reduce((all, one) => all + one.seconds, 0)).toBe(7_200);
  });
});

describe("what the ledger says about the price", () => {
  test("it says there is none, rather than leaving a zero to be read as free", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);

    if (typeof ledger === "string") {
      throw new Error(ledger);
    }

    expect(ledgerLines(ledger)).toContain(noPriceHere);
  });

  test("it names the account as a flat-rate login", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);

    expect(ledgerLines(ledger as Exclude<typeof ledger, string>).join("\n")).toContain("정액제 ChatGPT 로그인");
  });

  test("it says the tokens are all there is, and no zero price stands unexplained", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);
    const said = ledgerLines(ledger as Exclude<typeof ledger, string>).join("\n");

    expect(said).toContain("토큰당 값은 매기지 않습니다");
    expect(said).toContain("0원이 아니라 값이라는 것이 없습니다");
  });

  // A run the codex login never drove must not be told it rode one.
  test("each road names its own login, and a road that did not drive the run is not named", async () => {
    const root = await runOf([sanitizer]);
    const path = join(gateFolder(root, sanitizer.gate), metaFile);
    const meta = JSON.parse(readFileSync(path, "utf8")) as SynthMeta;

    writeFileSync(path, JSON.stringify({ ...meta, road: "claude", roads: ["claude"] }));

    const ledger = readLedger(root, [sanitizer]);
    const said = ledgerLines(ledger as Exclude<typeof ledger, string>).join("\n");

    expect(said).toContain("정액제 Claude 구독 로그인");
    expect(said).not.toContain("ChatGPT");
    expect(said).toContain(noPriceHere);
  });
});

describe("what the ledger prints", () => {
  test("every gate's figures are in it", async () => {
    const ledger = readLedger(await runOf([sanitizer, notes]), [sanitizer, notes]);
    const said = ledgerLines(ledger as Exclude<typeof ledger, string>).join("\n");

    expect(said).toContain(sanitizer.gate);
    expect(said).toContain(notes.gate);
    expect(said).toContain("지은 행 24 · 산 행 20");
    expect(said).toContain("버린 행 no-questions 4");
    expect(said).toContain("새 입력 360 · 캐시읽기 44032");
  });

  test("it names the model and the road it was written on", async () => {
    const ledger = readLedger(await runOf([sanitizer]), [sanitizer]);

    expect(ledgerLines(ledger as Exclude<typeof ledger, string>)[1]).toBe("모델 gpt-5.6-terra (high), 길 codex");
  });
});
