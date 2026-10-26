import { describe, expect, test } from "bun:test";

import { gateFor, judgeItemOf, judgePrompt as gateJudgePrompt, judgeSystem as gateJudgeSystem, judgedRows, readJudgements } from "../../training/tooling/src/gate-judge";
import { promptFile } from "../../training/tooling/src/prompts";
import { unjudgedRowOf } from "../../training/tooling/src/real-rows";
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

// What the training tooling tells its judges is English (docs/layout.md, "The rules the layout keeps"); Korean
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

  test("the prompts the judge is handed carry no Hangul of its own", () => {
    expect(gateJudgeSystem()).not.toMatch(hangul);
    expect(gateJudgePrompt(spec, [judgeItemOf(row)])).not.toMatch(hangul);
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
});
