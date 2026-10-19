import { describe, expect, test } from "bun:test";

import { labelKey } from "../../../training/tooling/src/reference/labels";
import { charsPerBatch, heldTo, judgeBatches, judgedAgain, judgeItem, judgePrompt, judgeSystem, readJudgement, turnsToJudge, unjudged, unlabelled, workLine } from "../../../training/tooling/src/reference/judge";

import type { Label } from "../../../training/tooling/src/reference/labels";
import type { LiveTurn } from "../../../training/tooling/src/reference/live-inputs";
import type { ReferenceTurn } from "../../../training/tooling/src/reference/turns";
import { useToolingSettings } from "../settings";

useToolingSettings();

const turn = (attached: string[] | null, recorded: ReferenceTurn["recorded"] = []): ReferenceTurn => ({
  key: "-7:3", chatId: -7, messageIds: [3], at: 0, source: "run", attached: attached === null ? null : new Set(attached), reply: "\uB2F5", recorded,
});

const live: LiveTurn = {
  chatId: -7,
  messageIds: [3],
  missing: false,
  gates: [{
    gate: "room-rules", held: 2, capped: 0,
    candidates: [{ slug: "quiet", about: "\uBC24\uC5D0\uB294 \uC870\uC6A9\uD788" }, { slug: "photos", about: "\uC0AC\uC9C4 \uC62C\uB9AC\uAE30" }],
    request: { state: "s", questions: {} },
  }],
  pieces: [
    { gate: "room-rules", slug: "quiet", about: "\uBC24\uC5D0\uB294 \uC870\uC6A9\uD788", body: "# \uC870\uC6A9\uD788\n\uC5F4\uD55C \uC2DC \uB118\uC73C\uBA74 \uC54C\uB9BC \uAE08\uC9C0" },
    { gate: "system-documents", slug: "structure", about: "\uAD6C\uC870", body: "# \uAD6C\uC870" },
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

describe("judging a word again", () => {
  const worded = (slug: string, word: Label["word"], at: string): [string, Label] =>
    [labelKey("-7:3", "room-rules", slug), { turn: "-7:3", gate: "room-rules", slug, word, attached: false, batch: 0, at }];

  test("asks only about the word's labels judged before the moment, and not about pieces with none", () => {
    const labels = new Map([worded("quiet", "needed", "2026-09-24T00:00:00.000Z"), worded("photos", "needed", "2026-09-26T00:00:00.000Z")]);

    expect(unjudged(turn(null), live, labels, judgedAgain("needed", "2026-09-25T19:00:00.000Z")))
      .toEqual([{ gate: "room-rules", slug: "quiet", attached: false }]);
    expect(unjudged(turn(null), live, new Map([worded("quiet", "not-needed", "2026-09-24T00:00:00.000Z")]), judgedAgain("needed", "2026-09-25T19:00:00.000Z")))
      .toEqual([]);
  });

  test("leaves a corrected label alone", () => {
    const [key, label] = worded("quiet", "needed", "2026-09-24T00:00:00.000Z");

    expect(unjudged(turn(null), live, new Map([[key, { ...label, batch: "corrected", by: "item 9" }]]), judgedAgain("needed", "2026-09-25T19:00:00.000Z")))
      .toEqual([]);
  });

  test("a pass held to some gates asks about nothing outside them", () => {
    expect(unjudged(turn(null), live, new Map(), heldTo(["people-search"], unlabelled))).toEqual([]);
    expect(unjudged(turn(null), live, new Map(), heldTo([], unlabelled))).toHaveLength(2);
  });
});

describe("turnsToJudge", () => {
  test("takes the first turns that still want a label, up to the bound", () => {
    const turns = [{ wanted: [] }, { wanted: [1] }, { wanted: [1] }, { wanted: [1] }];

    expect(turnsToJudge(turns, 2)).toEqual([turns[1]!, turns[2]!]);
  });
});

describe("the judge's item and answer", () => {
  const item = judgeItem({ key: "-7:3", reply: "\uC548 \uB3FC\uC694" }, ["\uC0AC\uB78C (id 1): \uBC24\uC5D0 \uC54C\uB9BC \uBCF4\uB0B4\uB3C4 \uB3FC?"], unjudged(turn(["quiet"]), live, new Map()), live, (text) => text);

  test("a turn the bot's instructions opened carries them, and the judge is told what such a turn is", () => {
    const opened = judgeItem({ key: "chat:-7:1:2", reply: "<<SKIP>>", instructions: "[\uBB38\uC11C \uAC31\uC2E0 \uACF5\uC9C0] STRUCTURE.md" }, [], [], live, (text) => text);

    expect(JSON.parse(judgePrompt([opened]).split("\n")[1]!)).toMatchObject({ messages: [], instructions: "[\uBB38\uC11C \uAC31\uC2E0 \uACF5\uC9C0] STRUCTURE.md", reply: "<<SKIP>>" });
    expect(JSON.parse(judgePrompt([item]).split("\n")[1]!)).not.toHaveProperty("instructions");
    expect(judgeSystem()).toContain("<<SKIP>>");
  });

  test("a piece of work says which kind it is, a search's question standing as instructions, and the judge is told what it is", () => {
    const search = judgeItem({ key: "search:4", reply: "# Findings", work: { kind: "search", query: "release notes" } }, [], [], live, (text) => text);
    const job = judgeItem(
      { key: "job:12", reply: "Done.", work: { kind: "job", title: "A server", instruction: "Build it.", requester: "owner", requesterId: 5 } },
      ["owner (id 5): A server\nBuild it."], [], live, (text) => text,
    );

    expect(JSON.parse(judgePrompt([search]).split("\n")[1]!)).toMatchObject({ messages: [], instructions: "release notes", work: "search", reply: "# Findings" });
    expect(JSON.parse(judgePrompt([job]).split("\n")[1]!)).toMatchObject({ messages: ["owner (id 5): A server\nBuild it."], work: "job" });
    expect(JSON.parse(judgePrompt([job]).split("\n")[1]!)).not.toHaveProperty("instructions");
    expect(judgeSystem()).toContain(workLine);
  });

  test("shows an attached piece's body and an offered piece's index line, and never who picked it", () => {
    const shown = judgePrompt([item]);

    expect(shown).toContain("\uC5F4\uD55C \uC2DC \uB118\uC73C\uBA74 \uC54C\uB9BC \uAE08\uC9C0");
    expect(shown).toContain("photos: \uC0AC\uC9C4 \uC62C\uB9AC\uAE30");
    expect(shown).not.toContain("llm");
    expect(judgeSystem()).toContain("- used: ");
  });

  test("reads the words offered for each piece's kind and nothing else", () => {
    const answer = JSON.stringify([{ id: "-7:3", labels: { "room-rules/quiet": "needed", "room-rules/photos": "not-needed" } }]);
    const labels = readJudgement(answer, [item], 4, "t");

    expect(labels).toEqual([{ turn: "-7:3", gate: "room-rules", slug: "photos", word: "not-needed", attached: false, batch: 4, at: "t" }]);
  });

  test("reads a piece answered under its bare slug where no other piece of the item shares it", () => {
    const answer = JSON.stringify([{ id: "-7:3", labels: { quiet: "used", photos: "not-needed" } }]);
    const twice = { ...item, pieces: [...item.pieces, { gate: "system-documents" as const, slug: "photos", attached: false, line: "photos", body: null }] };

    expect(readJudgement(answer, [item], 4, "t").map((label) => `${label.slug}=${label.word}`)).toEqual(["quiet=used", "photos=not-needed"]);
    expect(readJudgement(answer, [twice], 4, "t").map((label) => `${label.slug}=${label.word}`)).toEqual(["quiet=used"]);
  });

  test("a batch always takes one item, and stops at its character bound", () => {
    const big = { ...item, reply: "\uAC00".repeat(charsPerBatch) };

    expect(judgeBatches([big, item, item]).map((batch) => batch.length)).toEqual([1, 2]);
  });
});
