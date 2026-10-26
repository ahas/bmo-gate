import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { driveGates } from "../../training/tooling/src/gate-run";
import { ledgerLines, noPriceHere, readLedger } from "../../training/tooling/src/gate-ledger";
import { gateFolder } from "../../training/tooling/src/roots";
import { metaFile } from "../../training/tooling/src/laya-synth-run";
import { synthesisFor } from "../../training/tooling/src/laya-synth";
import { scratchDir } from "./scratch";

import type { GateSynthesis, LanguageBucket, SynthAsk, SynthRow } from "../../training/tooling/src/laya-synth";
import type { SynthAsker, SynthMeta } from "../../training/tooling/src/laya-synth-run";
import { useToolingSettings } from "./settings";

useToolingSettings();

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

const folds = gate("output-format");
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

  return typeof spec.example.state === "string" ? said : { ...(spec.example.state as Record<string, unknown>), ...Object.fromEntries(spec.textFields.map((field) => [field, said])) };
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
    const ledger = readLedger(await runOf([folds, notes]), [folds, notes]);

    expect(typeof ledger === "string" ? [] : ledger.gates.map((one) => one.gate).sort())
      .toEqual([notes.gate, folds.gate].sort());
  });

  test("a gate that never started is left out, not entered as a row of zeroes", async () => {
    const ledger = readLedger(await runOf([folds]), [folds, notes]);

    expect(typeof ledger === "string" ? [] : ledger.gates.map((one) => one.gate)).toEqual([folds.gate]);
  });

  test("a run where nothing started says so rather than reading as an empty ledger", () => {
    expect(readLedger(scratch(), [folds])).toContain("No gate has started under");
  });

  test("it names the model, the effort and the road", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);

    expect(ledger).toMatchObject({ models: [{ model: "gpt-5.6-terra", effort: "high" }], roads: ["codex"] });
  });

  // A run whose gates did not share a road did not share a model either, and naming one of them as
  // the run's would put the other gate's rows under a model that never wrote them.
  test("it names every model its gates were written with, once each", async () => {
    const root = await runOf([folds, notes]);

    await driveGates({
      root,
      gates: [folds],
      rows: 40,
      batchSize: 5,
      model: "qwen3.8-27b",
      effort: "none",
      road: "local",
      shares: { calibration: 0.15, test: 0.15 },
      atOnce: 1,
      resume: true,
      overwrite: true,
    }, standIn);

    const ledger = readLedger(root, [folds, notes]);

    expect(typeof ledger === "string" ? null : ledger.models)
      .toEqual([{ model: "qwen3.8-27b", effort: "none" }, { model: "gpt-5.6-terra", effort: "high" }]);
    expect(typeof ledger === "string" ? null : ledger.roads).toEqual(["codex", "local"]);
  });
});

describe("what the ledger records of a gate", () => {
  test("rows written and rows kept are both there, and they differ", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);
    const one = typeof ledger === "string" ? null : ledger.gates[0]!;

    // Four batches of five, each carrying one row the gate refuses.
    expect(one!.written).toBe(24);
    expect(one!.kept).toBe(20);
  });

  test("the three split counts add up to the rows kept", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);
    const one = typeof ledger === "string" ? null : ledger.gates[0]!;

    expect(one!.splits.train + one!.splits.calibration + one!.splits.test).toBe(one!.kept);
  });

  test("batches done against planned are both there", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);

    expect(typeof ledger === "string" ? null : ledger.gates[0]).toMatchObject({ batchesDone: 4, batchesPlanned: 4 });
  });

  test("refusals are broken out by reason rather than lumped into a count", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);
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
      gates: [folds],
      rows: 20,
      batchSize: 5,
      model: "qwen3.8-27b",
      effort: "none",
      road: "local",
      shares: { calibration: 0.15, test: 0.15 },
      atOnce: 1,
      resume: false,
      overwrite: false,
    }, async (spec, ask, resume) => {
      if (ask.seed.endsWith("-3")) {
        throw new Error("\uC138\uC158\uC774 \uB04A\uACBC\uC2B5\uB2C8\uB2E4");
      }

      return standIn(spec, ask, resume);
    });

    const ledger = readLedger(root, [folds]);

    expect(typeof ledger === "string" ? null : ledger.gates[0])
      .toMatchObject({ roads: ["local"], model: "qwen3.8-27b", effort: "none", threadHeld: false });
    expect(typeof ledger === "string" ? null : ledger.models).toEqual([{ model: "qwen3.8-27b", effort: "none" }]);
  });

  test("a lost batch is counted", async () => {
    const root = scratch();

    await driveGates({
      root,
      gates: [folds],
      rows: 10,
      batchSize: 5,
      model: "gpt-5.6-terra",
      effort: "high",
      shares: { calibration: 0.15, test: 0.15 },
      atOnce: 1,
      resume: false,
      overwrite: false,
    }, async () => ({ text: "\uD589 \uBAA9\uB85D\uC774 \uC544\uB2C8\uB77C \uADF8\uB0E5 \uD560 \uB9D0", sessionId: "held", tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }));

    expect(typeof readLedger(root, [folds]) === "string" ? null : (readLedger(root, [folds]) as { gates: { lostBatches: number }[] }).gates[0])
      .toMatchObject({ lostBatches: 2 });
  });

  test("fresh input and cache reads stand apart", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);
    const one = typeof ledger === "string" ? null : ledger.gates[0]!;

    // Four batches at 90 fresh and 11,008 cached each. Added together they would be one figure
    // saying nothing about whether the thread did its job.
    expect(one!.tokens.inputTokens).toBe(360);
    expect(one!.tokens.cacheReadTokens).toBe(44_032);
    expect(one!.tokens.cacheWriteTokens).toBe(20);
    expect(one!.tokens.outputTokens).toBe(1_600);
  });

  test("the thread a gate held is recorded", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);

    expect(typeof ledger === "string" ? null : ledger.gates[0]).toMatchObject({ threadHeld: true });
  });

  test("the wall time comes off the gate's own start and finish", async () => {
    const root = await runOf([folds]);
    const path = join(gateFolder(root, folds.gate), metaFile);
    const meta = JSON.parse(readFileSync(path, "utf8")) as SynthMeta;

    meta.started = "2026-09-23T00:00:00.000Z";
    meta.written = "2026-09-23T00:02:30.000Z";
    writeFileSync(path, JSON.stringify(meta, null, 2));

    expect(typeof readLedger(root, [folds]) === "string" ? null : (readLedger(root, [folds]) as { gates: { seconds: number }[] }).gates[0])
      .toMatchObject({ seconds: 150 });
  });
});

describe("the ledger's totals", () => {
  test("the rows and batches are the gates' added up", async () => {
    const ledger = readLedger(await runOf([folds, notes]), [folds, notes]);

    if (typeof ledger === "string") {
      throw new Error(ledger);
    }

    expect(ledger.totals.written).toBe(ledger.gates.reduce((all, one) => all + one.written, 0));
    expect(ledger.totals.kept).toBe(ledger.gates.reduce((all, one) => all + one.kept, 0));
    expect(ledger.totals.batchesDone).toBe(ledger.gates.reduce((all, one) => all + one.batchesDone, 0));
  });

  test("the tokens are the gates' added up, field by field", async () => {
    const ledger = readLedger(await runOf([folds, notes]), [folds, notes]);

    if (typeof ledger === "string") {
      throw new Error(ledger);
    }

    expect(ledger.totals.tokens.cacheReadTokens).toBe(ledger.gates.reduce((all, one) => all + one.tokens.cacheReadTokens, 0));
    expect(ledger.totals.tokens.inputTokens).toBe(ledger.gates.reduce((all, one) => all + one.tokens.inputTokens, 0));
  });

  test("the run's wall time is the run's, not the gates' times added together", async () => {
    const root = await runOf([folds, notes]);

    for (const [spec, from, to] of [[folds, "2026-09-23T00:00:00.000Z", "2026-09-23T01:00:00.000Z"], [notes, "2026-09-23T00:00:00.000Z", "2026-09-23T01:00:00.000Z"]] as const) {
      const path = join(gateFolder(root, spec.gate), metaFile);
      const meta = JSON.parse(readFileSync(path, "utf8")) as SynthMeta;

      meta.started = from;
      meta.written = to;
      writeFileSync(path, JSON.stringify(meta, null, 2));
    }

    const ledger = readLedger(root, [folds, notes]);

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
    const ledger = readLedger(await runOf([folds]), [folds]);

    if (typeof ledger === "string") {
      throw new Error(ledger);
    }

    expect(ledgerLines(ledger)).toContain(noPriceHere);
  });

  test("it names the account as a flat-rate login", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);

    expect(ledgerLines(ledger as Exclude<typeof ledger, string>).join("\n")).toContain("flat-rate ChatGPT login");
  });

  test("it says the tokens are all there is, and no zero price stands unexplained", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);
    const said = ledgerLines(ledger as Exclude<typeof ledger, string>).join("\n");

    expect(said).toContain("no price per token is put on them");
    expect(said).toContain("That is not a price of nothing: there is no price at all.");
  });

  // A run the codex login never drove must not be told it rode one.
  test("each road names its own login, and a road that did not drive the run is not named", async () => {
    const root = await runOf([folds]);
    const path = join(gateFolder(root, folds.gate), metaFile);
    const meta = JSON.parse(readFileSync(path, "utf8")) as SynthMeta;

    writeFileSync(path, JSON.stringify({ ...meta, road: "claude", roads: ["claude"] }));

    const ledger = readLedger(root, [folds]);
    const said = ledgerLines(ledger as Exclude<typeof ledger, string>).join("\n");

    expect(said).toContain("flat-rate Claude subscription login");
    expect(said).not.toContain("ChatGPT");
    expect(said).toContain(noPriceHere);
  });
});

describe("what the ledger prints", () => {
  test("every gate's figures are in it", async () => {
    const ledger = readLedger(await runOf([folds, notes]), [folds, notes]);
    const said = ledgerLines(ledger as Exclude<typeof ledger, string>).join("\n");

    expect(said).toContain(folds.gate);
    expect(said).toContain(notes.gate);
    expect(said).toContain("rows written 24 · rows kept 20");
    expect(said).toContain("rows refused no-questions 4");
    expect(said).toContain("fresh input 360 · cache reads 44032");
  });

  test("it names the model and the road it was written on", async () => {
    const ledger = readLedger(await runOf([folds]), [folds]);

    expect(ledgerLines(ledger as Exclude<typeof ledger, string>)[1]).toBe("model gpt-5.6-terra (high), road codex");
  });
});
