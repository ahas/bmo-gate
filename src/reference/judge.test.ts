import { describe, expect, test } from "bun:test";

import { labelKey } from "./labels";
import { charsPerBatch, judgeBatches, judgeItem, judgePrompt, judgeSystem, readJudgement, turnsToJudge, unjudged } from "./judge";

import type { Label } from "./labels";
import type { LiveTurn } from "./live-inputs";
import type { ReferenceTurn } from "./turns";

const turn = (attached: string[] | null, recorded: ReferenceTurn["recorded"] = []): ReferenceTurn => ({
  key: "-7:3", chatId: -7, messageIds: [3], at: 0, source: "run", attached: attached === null ? null : new Set(attached), reply: "답", recorded,
});

const live: LiveTurn = {
  chatId: -7,
  messageIds: [3],
  missing: false,
  gates: [{
    gate: "room-rules", held: 2, capped: 0,
    candidates: [{ slug: "quiet", about: "밤에는 조용히" }, { slug: "photos", about: "사진 올리기" }],
    request: { state: "s", questions: {} },
  }],
  pieces: [
    { gate: "room-rules", slug: "quiet", about: "밤에는 조용히", body: "# 조용히\n열한 시 넘으면 알림 금지" },
    { gate: "system-documents", slug: "structure", about: "구조", body: "# 구조" },
  ],
};

const labelled = (slug: string): [string, Label] =>
  [labelKey("-7:3", "room-rules", slug), { turn: "-7:3", gate: "room-rules", slug, word: "unused", attached: true, batch: 0, at: "t" }];

describe("unjudged", () => {
  test("asks about every candidate without a label, attached where the turn says it was", () => {
    expect(unjudged(turn(["quiet"]), live, new Map([labelled("photos")]))).toEqual([{ gate: "room-rules", slug: "quiet", attached: true }]);
  });

  test("asks about a piece the record attached even where the narrowing no longer offers it", () => {
    const picks = [{ gate: "system-documents" as const, slug: "structure", llm: true, attached: true }];

    expect(unjudged(turn(null, picks), live, new Map())).toContainEqual({ gate: "system-documents", slug: "structure", attached: true });
  });

  test("judges every piece of a turn whose attachments are unknown as offered", () => {
    expect(unjudged(turn(null), live, new Map()).every((one) => !one.attached)).toBe(true);
  });
});

describe("turnsToJudge", () => {
  test("takes the first turns that still want a label, up to the bound", () => {
    const turns = [{ wanted: [] }, { wanted: [1] }, { wanted: [1] }, { wanted: [1] }];

    expect(turnsToJudge(turns, 2)).toEqual([turns[1]!, turns[2]!]);
  });
});

describe("the judge's item and answer", () => {
  const item = judgeItem("-7:3", ["사람 (id 1): 밤에 알림 보내도 돼?"], "안 돼요", unjudged(turn(["quiet"]), live, new Map()), live, (text) => text);

  test("shows an attached piece's body and an offered piece's index line, and never who picked it", () => {
    const shown = judgePrompt([item]);

    expect(shown).toContain("열한 시 넘으면 알림 금지");
    expect(shown).toContain("photos: 사진 올리기");
    expect(shown).not.toContain("llm");
    expect(judgeSystem).toContain("- used: ");
  });

  test("reads the words offered for each piece's kind and nothing else", () => {
    const answer = JSON.stringify([{ id: "-7:3", labels: { "room-rules/quiet": "needed", "room-rules/photos": "not-needed" } }]);
    const labels = readJudgement(answer, [item], 4, "t");

    expect(labels).toEqual([{ turn: "-7:3", gate: "room-rules", slug: "photos", word: "not-needed", attached: false, batch: 4, at: "t" }]);
  });

  test("a batch always takes one item, and stops at its character bound", () => {
    const big = { ...item, reply: "가".repeat(charsPerBatch) };

    expect(judgeBatches([big, item, item]).map((batch) => batch.length)).toEqual([1, 2]);
  });
});
