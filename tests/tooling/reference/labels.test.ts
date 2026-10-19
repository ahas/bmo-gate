import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "../scratch";
import {
  appendLabels,
  attachedWordNames,
  attachedWords,
  correctedLabels,
  goldShare,
  goldYes,
  importedLabels,
  labelKey,
  offeredWordNames,
  offeredWords,
  readLabels,
} from "../../../training/tooling/src/reference/labels";

import type { Label } from "../../../training/tooling/src/reference/labels";

const root = scratchDir("bmo-reference-labels-");
let made = 0;

function folder(): string {
  made += 1;
  const where = join(root, `case-${made}`);

  mkdirSync(where, { recursive: true });

  return where;
}

describe("the judge's words", () => {
  test("are the words the document names, each defined in the judge's data", () => {
    const doc = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "reference-data.md"), "utf8");

    expect(Object.keys(attachedWords)).toEqual([...attachedWordNames]);
    expect(Object.keys(offeredWords)).toEqual([...offeredWordNames]);

    for (const [word, meaning] of [...Object.entries(attachedWords), ...Object.entries(offeredWords)]) {
      expect(doc).toContain(`- \`${word}\` — `);
      expect(meaning.trim()).not.toBe("");
    }
  });
});

describe("the gold of a word", () => {
  test("used and needed are yes, unused and not-needed no, related contested", () => {
    expect([goldYes("used"), goldYes("needed"), goldYes("unused"), goldYes("not-needed"), goldYes("related")]).toEqual([true, true, false, false, null]);
    expect([goldShare("used"), goldShare("not-needed"), goldShare("related")]).toEqual([0.95, 0.05, 0.5]);
  });
});

describe("the label file", () => {
  const one = (word: Label["word"], at: string): Label => ({ turn: "1:2", gate: "room-rules", slug: "quiet", word, attached: false, batch: 0, at });

  test("keeps the latest line for a key", () => {
    const path = join(folder(), "labels.jsonl");

    appendLabels(path, [one("not-needed", "a")]);
    appendLabels(path, [one("needed", "b")]);

    expect(readLabels(path).get(labelKey("1:2", "room-rules", "quiet"))!.word).toBe("needed");
  });

  test("takes in the first judging's labels, and only the words offered for a candidate's kind", () => {
    const path = join(folder(), "turns.jsonl");

    writeFileSync(path, `${JSON.stringify({
      id: "-5:9",
      candidates: [
        { gate: "system-documents", slug: "structure", attached: true, label: "used" },
        { gate: "system-documents", slug: "wording", attached: false, label: "used" },
        { gate: "situation-rules", slug: "evening", attached: false, label: "needed" },
        { gate: "people-search", slug: "p1-work", attached: false, label: null },
      ],
    })}\n`);

    expect(importedLabels(path, "now")).toEqual([
      { turn: "-5:9", gate: "system-documents", slug: "structure", word: "used", attached: true, batch: "imported", at: "now" },
    ]);
  });
});

describe("correcting labels", () => {
  const held = (slug: string, word: Label["word"], attached: boolean): [string, Label] =>
    [labelKey("1:2", "library-knowledge", slug), { turn: "1:2", gate: "library-knowledge", slug, word, attached, batch: 7, at: "then" }];
  const standing = new Map([held("restart-loop", "needed", false), held("deploy", "related", true)]);
  const line = (slug: string, word: string, gate = "library-knowledge"): string => JSON.stringify({ turn: "1:2", gate, slug, word });

  test("appends the word given, keeping whether the standing label was attached", () => {
    expect(correctedLabels(`${line("restart-loop", "not-needed")}\n\n${line("deploy", "used")}\n`, standing, "item 9", "now")).toEqual({
      labels: [
        { turn: "1:2", gate: "library-knowledge", slug: "restart-loop", word: "not-needed", attached: false, batch: "corrected", by: "item 9", at: "now" },
        { turn: "1:2", gate: "library-knowledge", slug: "deploy", word: "used", attached: true, batch: "corrected", by: "item 9", at: "now" },
      ],
    });
  });

  test("refuses the whole file, naming every line that cannot stand", () => {
    const text = [
      line("restart-loop", "not-needed"),
      "{",
      line("restart-loop", "unused"),
      line("missing", "needed"),
      line("restart-loop", "needed", "situation-rules"),
    ].join("\n");

    expect(correctedLabels(text, standing, "item 9", "now")).toEqual({
      refused: [
        "line 2: not JSON",
        "line 3: unused is not a word for an offered piece",
        "line 4: 1:2/library-knowledge/missing has no standing label",
        "line 5: situation-rules is not a reference gate",
      ],
    });
  });
});
