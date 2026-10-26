import { describe, expect, test } from "bun:test";

import { gateFor, judgeBatches, judgeItemOf, judgePrompt, judgeSystem, judgedRows, readJudgements } from "../../training/tooling/src/gate-judge";
import { unjudgedRowOf } from "../../training/tooling/src/real-rows";

import type { JudgeItem } from "../../training/tooling/src/gate-judge";
import type { UnjudgedRow } from "../../training/tooling/src/real-rows";
import { useToolingSettings } from "./settings";

useToolingSettings();

const shares = { calibration: 0.15, test: 0.15 };
const spec = gateFor("reply-wanted");

function rowOf(message: string): UnjudgedRow {
  return unjudgedRowOf(
    "reply-wanted",
    {
      room: "group",
      recent: ["[2026-06-19T08:12:41.000Z] #5510 \uC138\uC601 (id 3391044): Robin\uC57C \uC774\uBC88 \uC8FC \uB2F9\uBC88 \uB204\uAD6C\uC9C0"],
      message,
    },
    { forAgent: { type: "noul", instructions: spec.questions[0]!.instructions } },
    shares,
  );
}

const row = rowOf("[2026-06-19T08:13:20.000Z] #5512 \uC138\uC601 (id 3391044): \uC544 \uB9DE\uB2E4 \uACE0\uB9C8\uC6CC");
const items: JudgeItem[] = [{ id: row.id, state: row.state, questions: row.questions }];

describe("judgeItemOf", () => {
  test("the judge reads the whole a row keeps beside the reduction its gate is shown", () => {
    const row = { ...rowOf("Robin\uC57C \uC54C\uB824 \uC918"), teacher: { message: "\uC804\uCCB4 \uC6D0\uBB38" } };

    expect(judgeItemOf(row).state).toEqual({ message: "\uC804\uCCB4 \uC6D0\uBB38" });
    expect(judgeItemOf(rowOf("Robin\uC57C \uC54C\uB824 \uC918")).state).toEqual(rowOf("Robin\uC57C \uC54C\uB824 \uC918").state);
  });
});

describe("judgePrompt", () => {
  test("names the answers outright, since a judge left to guess writes yes and no", () => {
    const prompt = judgePrompt(spec, items);

    expect(prompt).toContain("forAgent: true, false");
    expect(prompt).toContain(row.id);
  });

  test("says nothing about a gate in the system prompt, so one prefix serves every batch", () => {
    expect(judgeSystem()).not.toContain("reply-wanted");
  });
});

describe("readJudgements", () => {
  test("reads a plain array back", () => {
    const answer = `[{"id": ${JSON.stringify(row.id)}, "gold": {"forAgent": {"probabilities": {"true": 0.8, "false": 0.2}}}}]`;
    const reading = readJudgements(answer, items);

    expect(reading.refused).toBe(0);
    expect(reading.golds.get(row.id)?.forAgent).toEqual({
      type: "noul", label: "true", noul: 0.8, probabilities: { true: 0.8, false: 0.2 },
    });
  });

  test("reads an array the model wrapped in prose and a fence", () => {
    const answer = `\uD310\uC815\uD588\uC2B5\uB2C8\uB2E4.\n\`\`\`json\n[{"id": ${JSON.stringify(row.id)}, "gold": {"forAgent": {"probabilities": {"true": 0.1, "false": 0.9}}}}]\n\`\`\``;

    expect(readJudgements(answer, items).golds.get(row.id)?.forAgent?.label).toBe("false");
  });

  test("normalises probabilities that do not add to one", () => {
    const answer = `[{"id": ${JSON.stringify(row.id)}, "gold": {"forAgent": {"probabilities": {"true": 3, "false": 1}}}}]`;

    expect(readJudgements(answer, items).golds.get(row.id)?.forAgent).toEqual({
      type: "noul", label: "true", noul: 0.75, probabilities: { true: 0.75, false: 0.25 },
    });
  });

  test("refuses an item whose gold names an answer the question does not have", () => {
    const answer = `[{"id": ${JSON.stringify(row.id)}, "gold": {"forAgent": {"probabilities": {"yes": 1}}}}]`;
    const reading = readJudgements(answer, items);

    expect(reading.golds.size).toBe(0);
    expect(reading.refused).toBe(1);
  });

  test("counts an item the answer said nothing about", () => {
    expect(readJudgements("[]", items).refused).toBe(1);
  });

  test("takes no answer for an item it never asked about", () => {
    const answer = '[{"id": "somebody-else:0000", "gold": {"forAgent": {"probabilities": {"true": 1, "false": 0}}}}]';

    expect(readJudgements(answer, items).golds.size).toBe(0);
  });
});

describe("judgedRows", () => {
  test("freezes a judged row with its gold and keeps the split the input fixed", () => {
    const answer = `[{"id": ${JSON.stringify(row.id)}, "gold": {"forAgent": {"probabilities": {"true": 0.9, "false": 0.1}}}}]`;
    const outcome = judgedRows(spec, [row], readJudgements(answer, items), shares, "conversation");

    expect(outcome.rows.length).toBe(1);
    expect(outcome.rows[0]!.row.split).toBe(row.split);
    expect(outcome.rows[0]!.row.id).toBe(row.id);
    expect(outcome.rows[0]!.source).toBe("conversation");
    expect(JSON.parse(outcome.rows[0]!.row.gold)).toHaveProperty("forAgent");
  });

  test("keeps an English room's row, because a real row's language is a fact and not a target", () => {
    const english = rowOf("[2026-06-19T08:13:20.000Z] #5512 Nadia (id 3391044): thanks, that works");
    const answer = `[{"id": ${JSON.stringify(english.id)}, "gold": {"forAgent": {"probabilities": {"true": 0.2, "false": 0.8}}}}]`;
    const asked: JudgeItem[] = [{ id: english.id, state: english.state, questions: english.questions }];
    const outcome = judgedRows(spec, [english], readJudgements(answer, asked), shares, "conversation");

    expect(outcome.rows.length).toBe(1);
  });

  test("refuses a row that does not answer its own gate and says why", () => {
    const broken = unjudgedRowOf("reply-wanted", { room: "group", recent: ["\uC904\uC774 \uC544\uB2CC \uAC83"], message: "\uC774\uAC83\uB3C4 \uC544\uB2C8\uB2E4" }, row.questions, shares);
    const answer = `[{"id": ${JSON.stringify(broken.id)}, "gold": {"forAgent": {"probabilities": {"true": 1, "false": 0}}}}]`;
    const asked: JudgeItem[] = [{ id: broken.id, state: broken.state, questions: broken.questions }];
    const outcome = judgedRows(spec, [broken], readJudgements(answer, asked), shares, "conversation");

    expect(outcome.rows).toEqual([]);
    expect(outcome.refusals["wrong-transcript"]).toBe(1);
  });

  test("leaves an unanswered row out rather than guessing at it", () => {
    const outcome = judgedRows(spec, [row], readJudgements("[]", items), shares, "conversation");

    expect(outcome.rows).toEqual([]);
    expect(outcome.unanswered).toBe(1);
  });
});

describe("judgeBatches", () => {
  const asking = (many: number, name: string): UnjudgedRow => ({
    id: `output-format:${name}`,
    gate: "output-format",
    split: "train",
    state: "\uB9D0",
    questions: Object.fromEntries(Array.from({ length: many }, (_, at) => [
      `piece-${at}`,
      { type: "noul" as const, instructions: "\uC774 \uB300\uD654\uC5D0 \uB2F5\uD558\uB824\uBA74 \uC774 \uC778\uBB3C \uAE30\uB85D\uC774 \uD544\uC694\uD55C\uAC00?" },
    ])),
  });

  test("counts a batch in answers, so a gate asking many questions of a row takes fewer rows", () => {
    const plan = judgeBatches(Array.from({ length: 12 }, (_, at) => asking(20, `a${at}`)), 20, 100);

    expect(plan.map((batch) => batch.length)).toEqual([5, 5, 2]);
  });

  test("stops at the rows it was asked for where the answers are few", () => {
    const plan = judgeBatches(Array.from({ length: 5 }, (_, at) => asking(1, `b${at}`)), 2, 100);

    expect(plan.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  test("takes a row that is past the cap on its own, since a plan with a hole in it is worse", () => {
    const plan = judgeBatches([asking(300, "c0"), asking(1, "c1")], 20, 100);

    expect(plan.map((batch) => batch.length)).toEqual([1, 1]);
  });

  test("puts every row in exactly one batch, in the order they stand", () => {
    const rows = [asking(60, "d0"), asking(60, "d1"), asking(1, "d2"), asking(1, "d3")];
    const plan = judgeBatches(rows, 20, 100);

    expect(plan.flat().map((one) => one.id)).toEqual(rows.map((one) => one.id));
  });
});
