import { describe, expect, test } from "bun:test";

import { distinctWorks, meanLabels, readTeaching, selfAgreement, teachBatches, trainingSplit, untaught, wantedSamples } from "../../../training/tooling/src/reference/distill";
import { labelKey } from "../../../training/tooling/src/reference/labels";

import type { DistilledLabel, TaughtWork, WorkInput } from "../../../training/tooling/src/reference/distill";
import { useToolingSettings } from "../settings";

useToolingSettings();

const work = (id: string, candidates: string[]): TaughtWork => ({ id, kind: "job", requester: "Alma", request: "Move the bench.", candidates });

function sample(turn: string, slug: string, sample: number, p: number): DistilledLabel {
  return { turn, gate: "library-knowledge", slug, word: p >= 0.5 ? "needed" : "not-needed", attached: false, batch: 0, at: "2026-10-11T00:00:00.000Z", p, why: "", sample };
}

function standing(...given: DistilledLabel[]): Map<string, Map<number, DistilledLabel>> {
  const labels = new Map<string, Map<number, DistilledLabel>>();

  for (const one of given) {
    const key = labelKey(one.turn, one.gate, one.slug);

    labels.set(key, (labels.get(key) ?? new Map()).set(one.sample, one));
  }

  return labels;
}

describe("readTeaching", () => {
  test("reads each candidate's word, probability and reason, and nothing it was not asked", () => {
    const answer = `[{"id": "job:7", "labels": {"nodes": {"word": "needed", "p": 0.8, "why": "It moves a card."}, "rust": {"word": "maybe", "p": 0.5}, "other": {"word": "needed", "p": 1}}}]`;
    const read = readTeaching(answer, [work("job:7", ["nodes", "rust", "korean"])], 4, "at", 2);

    expect(read.map((one) => [one.slug, one.word, one.p, one.why, one.sample, one.batch])).toEqual([["nodes", "needed", 0.8, "It moves a card.", 2, 4]]);
  });
});

describe("meanLabels", () => {
  test("stands only where every sample answered, at the samples' mean", () => {
    const meant = meanLabels(standing(
      sample("job:7", "nodes", 0, 0.9), sample("job:7", "nodes", 1, 0.6), sample("job:7", "nodes", 2, 0.0),
      sample("job:7", "rust", 0, 0.9),
    ));

    expect([...meant.values()].map((one) => [one.slug, one.word, one.p])).toEqual([["nodes", "needed", 0.5]]);
  });
});

describe("selfAgreement", () => {
  test("counts each sample against the mean of the others", () => {
    const agreed = selfAgreement(standing(sample("job:7", "nodes", 0, 0.9), sample("job:7", "nodes", 1, 0.8), sample("job:7", "nodes", 2, 0.2)));

    expect(agreed).toEqual({ asked: 3, agreed: 2 });
  });
});

describe("wantedSamples", () => {
  test("wants the samples some candidate has no answer of, and a work wanting none is taught", () => {
    const labels = standing(sample("job:7", "nodes", 0, 0.1), sample("job:7", "nodes", 1, 0.1), sample("job:7", "rust", 0, 0.1));

    expect(wantedSamples(work("job:7", ["nodes", "rust"]), labels)).toEqual([1, 2]);
    expect(untaught([work("job:7", ["nodes"])], standing(sample("job:7", "nodes", 0, 0), sample("job:7", "nodes", 1, 0), sample("job:7", "nodes", 2, 0)))).toEqual([]);
  });
});

describe("teachBatches", () => {
  test("keeps one room's works together, at most a batch's count each", () => {
    const batches = teachBatches([
      { ...work("job:1", ["a"]), chatId: 5 }, { ...work("job:2", ["a"]), chatId: 6 }, { ...work("job:3", ["a"]), chatId: 5 }, { ...work("job:4", ["a"]), chatId: 5 },
    ], 2);

    expect(batches.map((batch) => batch.map((one) => one.id))).toEqual([["job:1", "job:3"], ["job:4"], ["job:2"]]);
  });
});

describe("trainingSplit", () => {
  const reference = [{ id: "a", turn: "-7:3" }, { id: "b", turn: "job:9" }, { id: "c", turn: "job:10" }];
  const distilled = [{ id: "d", turn: "job:9", stratum: "work" }, { id: "e", turn: "task:4", stratum: "work" }];

  test("trains on the distilled rows in place of a taught work's own, each row named for its kind", () => {
    expect(trainingSplit("train", reference, distilled, new Set(["job:9", "task:4"])).map((row) => [row.id, row.stratum])).toEqual([["d", "work"], ["e", "work"], ["a", "turn"], ["c", "work"]]);
  });

  test("keeps the reference test whole", () => {
    expect(trainingSplit("test", reference, distilled, new Set(["job:9"])).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
});

describe("distinctWorks", () => {
  test("keeps one work per room and text, newest first", () => {
    const input = (key: string, chatId: number, at: number, query: string): WorkInput => ({ key, chatId, at, kind: "search", words: { kind: "search", query } });

    expect(distinctWorks([input("task:1", 5, 10, "check"), input("task:2", 5, 20, "check"), input("task:3", 6, 30, "check")]).map((one) => one.key))
      .toEqual(["task:3", "task:1"]);
  });
});
