import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { choosePass, curveLines, readCurve, runPass } from "./laya-curve";
import { freezeBatch, writeProgress } from "./laya-synth-run";
import { gateFolder } from "./roots";
import { scratchDir } from "./scratch";

import type { CurvePoint, CurveRule } from "./laya-curve";
import type { MergedPart } from "./gate-merge";
import type { DatasetSplit } from "./laya-dataset";
import type { TrainLedger, TrainLedgerRow } from "./laya-train";

const rule: CurveRule = { floor: 100, growth: 1.25 };
const started = "2026-09-23T13:23:29.866Z";

function count(gate: string, train: number, calibration: number, test: number, since = started): MergedPart {
  return { gate, rows: { train, calibration, test }, finished: false, started: since };
}

function point(gate: string, rows: number, state: CurvePoint["state"] = "done", pass = 1): CurvePoint {
  return {
    pass, at: "2026-09-24T02:00:00Z", run: "real-1", training: `real-1-p000${pass}`, gate, started,
    finished: false, rows, train: rows - 30, calibration: 15, test: 15, node: "n2", state,
    agreement: 0.9, balanced: 0.8, ece: 0.05, seconds: 300, fault: state === "done" ? null : "노드가 답하지 않아요",
  };
}

describe("which gates a pass trains", () => {
  test("a gate below the floor waits, and says how far it is from it", () => {
    const choice = choosePass([count("a", 60, 10, 10)], [], rule);

    expect(choice.train).toEqual([]);
    expect(choice.waiting).toEqual([{ gate: "a", rows: 80, reason: "최소 100행 미달" }]);
  });

  test("a gate over the floor with a split empty waits, since it cannot be calibrated or measured", () => {
    const choice = choosePass([count("a", 200, 10, 0)], [], rule);

    expect(choice.train).toEqual([]);
    expect(choice.waiting[0]!.reason).toBe("test 분할이 비어 있음");
  });

  test("a gate with no point yet is trained as soon as it clears the floor", () => {
    expect(choosePass([count("a", 80, 10, 10)], [], rule).train.map((one) => one.gate)).toEqual(["a"]);
  });

  test("a trained gate waits until it has grown by the ratio", () => {
    expect(choosePass([count("a", 104, 10, 10)], [point("a", 100)], rule).waiting[0]!.reason)
      .toBe("1회차 100행, 다음은 125행부터");
    expect(choosePass([count("a", 105, 10, 10)], [point("a", 100)], rule).train.map((one) => one.gate)).toEqual(["a"]);
  });

  test("a gate whose last point failed is tried once more on the same rows", () => {
    expect(choosePass([count("a", 80, 10, 10)], [point("a", 100, "unreachable")], rule).train.length).toBe(1);
  });

  test("a gate that failed twice on the same rows waits for a new row", () => {
    const failed = [point("a", 100, "failed", 1), point("a", 100, "failed", 2)];

    expect(choosePass([count("a", 80, 10, 10)], failed, rule).waiting[0]!.reason).toBe("2회차 100행, 다음은 101행부터");
    expect(choosePass([count("a", 81, 10, 10)], failed, rule).train.length).toBe(1);
  });

  test("a gate started over is a series of its own and is not held to the old series' points", () => {
    const choice = choosePass([count("a", 80, 10, 10, "2026-09-24T00:00:00Z")], [point("a", 500)], rule);

    expect(choice.train.map((one) => one.gate)).toEqual(["a"]);
  });
});

// A judging run folder with one gate in it, its batches frozen the way the judging freezes them.
function judging(root: string, gate: string, batches: number, from = 0): void {
  const folder = gateFolder(root, gate);

  writeProgress(folder, {
    started, model: "gpt-5.6-terra", effort: "high", road: "codex", rows: 6000, batchSize: 20,
    shares: { calibration: 0.15, test: 0.15 },
    gates: { [gate]: { done: from + batches, sessionId: null, kept: 0, refused: {}, unreadable: 0, lostBatches: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
  });

  const splits: DatasetSplit[] = ["train", "train", "train", "calibration", "test"];

  for (let index = from; index < from + batches; index += 1) {
    freezeBatch(folder, gate, index, Array.from({ length: 20 }, (_, at) => ({
      row: {
        id: `${gate}:${index}-${at}`, gate, split: splits[at % splits.length]!, state: "s", questions: "{}",
        gold: JSON.stringify({ q: { label: at % 4 === 0 ? "true" : "false" } }),
      },
      language: "korean" as const,
    })));
  }
}

function ledgerFor(gates: readonly string[], nodes: readonly string[], training: string): TrainLedger {
  return {
    run: training, dataset: training, rehearsal: false, started: "", ended: "", nodes: [...nodes],
    rows: gates.map((gate, index) => ({
      gate, node: nodes[index % nodes.length]!, round: 1, state: "done", seconds: 120,
      calibration: { agreement: 0.95, balanced: 0.9, ece: 0.03 }, fault: null,
    }) as TrainLedgerRow),
  };
}

describe("a pass", () => {
  test("cuts the growing gates, trains the ones that grew and keeps a point a gate", async () => {
    const root = scratchDir("bmo-gate-curve-");
    const curve = join(root, "curve");
    const trained: string[][] = [];
    const options = {
      root, run: "real-1", curve, trainingRoot: (training: string) => join(root, "runs", training), rule,
      nodes: async () => ["n2", "n3"],
      train: async (gates: readonly string[], nodes: readonly string[], training: string, folders: Record<string, string>) => {
        trained.push([...gates]);
        for (const gate of gates) {
          expect(existsSync(join(folders[gate]!, "test.jsonl"))).toBe(true);
        }

        return ledgerFor(gates, nodes, training);
      },
      now: () => new Date("2026-09-24T02:00:00Z"),
    };

    judging(root, "reply-wanted", 6);
    judging(root, "room-rules", 3);

    const first = await runPass(options);

    expect(first.pass).toBe(1);
    expect(first.training).toBe("real-1-p0001");
    expect(trained).toEqual([["reply-wanted"]]);
    expect(first.choice.waiting.map((one) => one.gate)).toEqual(["room-rules"]);
    expect(readCurve(curve).map((one) => [one.pass, one.gate, one.rows, one.test, one.balanced])).toEqual([
      [1, "reply-wanted", 120, 24, 0.9],
    ]);
    // The judging's own folder is left as it was: a split file there would read as a gate finished.
    expect(existsSync(join(gateFolder(root, "reply-wanted"), "train.jsonl"))).toBe(false);

    const idle = await runPass(options);

    expect(idle.pass).toBeNull();
    expect(readCurve(curve).length).toBe(1);

    judging(root, "reply-wanted", 2, 6);
    judging(root, "room-rules", 3, 3);

    const second = await runPass(options);

    expect(second.pass).toBe(2);
    expect(trained[1]).toEqual(["reply-wanted", "room-rules"]);
    expect(readCurve(curve).map((one) => [one.pass, one.gate, one.rows])).toEqual([
      [1, "reply-wanted", 120], [2, "reply-wanted", 160], [2, "room-rules", 120],
    ]);
    expect(curveLines(readCurve(curve)).join("\n")).toContain("reply-wanted");
  });

  test("with no node ready nothing is trained and nothing is written", async () => {
    const root = scratchDir("bmo-gate-curve-");
    const curve = join(root, "curve");

    judging(root, "reply-wanted", 6);

    const report = await runPass({
      root, run: "real-1", curve, trainingRoot: (training) => join(root, "runs", training), rule,
      nodes: async () => [],
      train: async () => { throw new Error("no training without a node"); },
    });

    expect(report.fault).toBe("학습시킬 노드가 하나도 준비되어 있지 않아요.");
    expect(readCurve(curve)).toEqual([]);
  });
});
