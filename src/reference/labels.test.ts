import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "../scratch";
import { appendLabels, attachedWords, goldShare, goldYes, importedLabels, labelKey, offeredWords, readLabels } from "./labels";

import type { Label } from "./labels";

const root = scratchDir("bmo-reference-labels-");
let made = 0;

function folder(): string {
  made += 1;
  const where = join(root, `case-${made}`);

  mkdirSync(where, { recursive: true });

  return where;
}

describe("the judge's words", () => {
  test("are the document's words, line for line", () => {
    const doc = readFileSync(join(import.meta.dir, "..", "..", "docs", "reference-data.md"), "utf8");

    for (const [word, meaning] of [...Object.entries(attachedWords), ...Object.entries(offeredWords)]) {
      expect(doc).toContain(`- \`${word}\` — ${meaning}`);
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
