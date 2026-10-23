import { describe, expect, test } from "bun:test";

import { gateFor, judgeItemOf, judgePrompt as gateJudgePrompt, judgeSystem as gateJudgeSystem, judgedRows, readJudgements } from "../../training/tooling/src/gate-judge";
import { promptFile } from "../../training/tooling/src/prompts";
import { unjudgedRowOf } from "../../training/tooling/src/real-rows";
import { judgePrompt as referenceJudgePrompt, judgeSystem as referenceJudgeSystem } from "../../training/tooling/src/reference/judge";
import { attachedWordNames, isWordFor, offeredWordNames, readLabels } from "../../training/tooling/src/reference/labels";
import { useToolingSettings } from "./settings";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

useToolingSettings();

const shares = { calibration: 0.15, test: 0.15 };
const spec = gateFor("reply-wanted");
const row = unjudgedRowOf(
  "reply-wanted",
  {
    room: "group",
    recent: ["[2026-06-19T08:12:41.000Z] #5510 Nadia (id 3391044): Robin, who is on duty this week?"],
    message: "[2026-06-19T08:13:20.000Z] #5512 Nadia (id 3391044): thanks, that works",
  },
  { forAgent: { type: "noul", instructions: spec.questions[0]!.instructions } },
  shares,
);

// What the training tooling tells its judges is English (docs/layout.md, 「The rules the layout keeps」); Korean
// stands in `prompts/tooling/` only as what the rows carry.
const hangul = /[\uAC00-\uD7A3\u3131-\u318E]/;

// Every text a file holds, by its dotted path, a list's texts under the list's own path.
function textsOf(value: unknown, path: string): [string, string][] {
  if (typeof value === "string") {
    return [[path, value]];
  }

  if (Array.isArray(value)) {
    return value.flatMap((one) => textsOf(one, path));
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, one]) => textsOf(one, path === "" ? key : `${path}.${key}`));
  }

  return [];
}

function hangulPaths(file: string): string[] {
  return [...new Set(textsOf(promptFile(file), "").filter(([, text]) => hangul.test(text)).map(([path]) => path))];
}

describe("what the judges are told", () => {
  test("every text the gate judge's file holds is English", () => {
    expect(hangulPaths("gate-judge")).toEqual([]);
  });

  test("every text the reference judge's file holds is English", () => {
    expect(hangulPaths("reference-judge")).toEqual([]);
  });

  test("the prompts the judges are handed carry no Hangul of their own", () => {

    expect(gateJudgeSystem()).not.toMatch(hangul);
    expect(gateJudgePrompt(spec, [judgeItemOf(row)])).not.toMatch(hangul);
    expect(referenceJudgeSystem()).not.toMatch(hangul);
    expect(referenceJudgePrompt([])).not.toMatch(hangul);
  });
});

describe("what the rows carry", () => {
  test("the stand-in names and the placeholders are the only Korean the stand-ins' file holds", () => {
    expect(hangulPaths("pii").every((path) => path === "hangul_names" || path.startsWith("placeholders."))).toBe(true);
  });

  test("the rehearsal's sentences are the only Korean the rehearsal's file holds", () => {
    expect(hangulPaths("rehearsal")).toEqual(["sentences"]);
  });
});

describe("rows judged before the judges' words were English", () => {
  test("a judged row carries the gate's questions and a gold over their answers, and no word of the judge's", () => {
    const answer = `[{"id": ${JSON.stringify(row.id)}, "gold": {"forAgent": {"probabilities": {"true": 0.9, "false": 0.1}}}}]`;
    const frozen = judgedRows(spec, [row], readJudgements(answer, [judgeItemOf(row)]), shares, "conversation").rows[0]!.row;
    const said = JSON.stringify(frozen);

    for (const line of gateJudgeSystem().split("\n")) {
      expect(said).not.toContain(line);
    }

    expect(frozen.id).toBe(row.id);
  });

  test("a label stands on its word, so every label judged before still reads as one the judge gives", () => {
    const folder = mkdtempSync(join(tmpdir(), "labels-"));
    const path = join(folder, "labels.jsonl");
    const words = [...attachedWordNames.map((word) => ({ word, attached: true })), ...offeredWordNames.map((word) => ({ word, attached: false }))];

    writeFileSync(path, words.map(({ word, attached }, index) => `${JSON.stringify({ turn: `1:${index}`, gate: "room-rules", slug: "quiet", word, attached, batch: 1, at: "2026-10-01T00:00:00.000Z" })}\n`).join(""));

    const read = [...readLabels(path).values()];

    expect(read.length).toBe(words.length);
    expect(read.every((one) => isWordFor(one.attached, one.word))).toBe(true);
  });
});
