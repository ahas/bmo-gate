import { describe, expect, test } from "bun:test";

import { gateFigures, labelledTurns, layaAnswersOf } from "../../../training/tooling/src/reference/figures";

import type { Label } from "../../../training/tooling/src/reference/labels";
import { useToolingSettings } from "../settings";

useToolingSettings();

const label = (turn: string, slug: string, word: Label["word"], attached: boolean): Label =>
  ({ turn, gate: "room-rules", slug, word, attached, batch: 0, at: "t" });

const labels = [
  label("a", "quiet", "used", true),
  label("a", "photos", "unused", true),
  label("a", "links", "needed", false),
  label("b", "quiet", "related", true),
  label("b", "photos", "not-needed", false),
];

describe("gateFigures", () => {
  test("reads over-selection and missing off the labels", () => {
    const figures = gateFigures("room-rules", [{ key: "a", recorded: [] }, { key: "b", recorded: [] }], labels, new Map());

    expect(figures).toMatchObject({ turns: 2, attached: 3, used: 1, related: 1, unused: 1, overSelection: 0.3333, offered: 2, needed: 1, missTurns: 1 });
  });

  test("holds the LLM gate's set to the gold on the turns the record holds", () => {
    const recorded = [{ gate: "room-rules" as const, slug: "quiet", llm: true, attached: true }, { gate: "room-rules" as const, slug: "links", llm: true, attached: false }];
    const figures = gateFigures("room-rules", [{ key: "a", recorded }], labels, new Map());

    // quiet yes and links yes match; photos was never picked, and its gold is no.
    expect([figures.llmMatchGold, figures.llmComparable]).toEqual([1, 1]);
  });

  test("settles each candidate at tau by its own confidence", () => {
    // quiet and photos answered right, links answered no where its gold is yes.
    const laya = new Map([["a/room-rules", { quiet: 0.9, photos: 0.2, links: 0.3 }]]);
    const figures = gateFigures("room-rules", [{ key: "a", recorded: [] }], labels, laya).laya!;
    const at = (tau: number) => figures.byTau.find((one) => one.tau === tau);

    expect([figures.turns, figures.candidates]).toEqual([1, 3]);
    expect(at(0.7)).toMatchObject({ settled: 3, share: 1, matchGold: 2, accuracyGold: 0.6667, wholeTurns: 1 });
    expect(at(0.8)).toMatchObject({ settled: 2, share: 0.6667, matchGold: 2, accuracyGold: 1, wholeTurns: 0 });
    expect(at(0.95)).toMatchObject({ settled: 0, accuracyGold: null, wholeTurns: 0 });
  });
});

describe("labelledTurns", () => {
  test("counts every turn a label was given on, known or not", () => {
    expect(labelledTurns([{ key: "a", recorded: [] }], labels).map((turn) => turn.key)).toEqual(["a", "b"]);
  });
});

describe("layaAnswersOf", () => {
  test("reads each question's yes", () => {
    expect(layaAnswersOf({ answers: { quiet: { noul: 0.8 }, odd: { choice: "x" } } })).toEqual({ quiet: 0.8 });
    expect(layaAnswersOf(null)).toBeNull();
  });
});
