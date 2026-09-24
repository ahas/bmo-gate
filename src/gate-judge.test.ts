import { describe, expect, test } from "bun:test";

import { gateFor, judgeBatches, judgeItemOf, judgePrompt, judgeSystem, judgedRows, readJudgements } from "./gate-judge";
import { unjudgedRowOf } from "./real-rows";

import type { JudgeItem } from "./gate-judge";
import type { UnjudgedRow } from "./real-rows";

const shares = { calibration: 0.15, test: 0.15 };
const spec = gateFor("reply-wanted");

function rowOf(message: string): UnjudgedRow {
  return unjudgedRowOf(
    "reply-wanted",
    {
      room: "group",
      recent: ["[2026-06-19T08:12:41.000Z] #5510 세영 (id 3391044): 비모야 이번 주 당번 누구지"],
      message,
    },
    { forBmo: { type: "noul", instructions: "이 메시지는 비모에게 한 말인가?" } },
    shares,
  );
}

const row = rowOf("[2026-06-19T08:13:20.000Z] #5512 세영 (id 3391044): 아 맞다 고마워");
const items: JudgeItem[] = [{ id: row.id, state: row.state, questions: row.questions }];

describe("judgeItemOf", () => {
  test("the judge reads the whole a row keeps beside the reduction its gate is shown", () => {
    const row = { ...rowOf("비모야 알려 줘"), teacher: { message: "전체 원문" } };

    expect(judgeItemOf(row).state).toEqual({ message: "전체 원문" });
    expect(judgeItemOf(rowOf("비모야 알려 줘")).state).toEqual(rowOf("비모야 알려 줘").state);
  });
});

describe("judgePrompt", () => {
  test("names the answers outright, since a judge left to guess writes yes and no", () => {
    const prompt = judgePrompt(spec, items);

    expect(prompt).toContain("forBmo: true, false");
    expect(prompt).toContain(row.id);
  });

  test("says nothing about a gate in the system prompt, so one prefix serves every batch", () => {
    expect(judgeSystem).not.toContain("reply-wanted");
  });
});

describe("readJudgements", () => {
  test("reads a plain array back", () => {
    const answer = `[{"id": ${JSON.stringify(row.id)}, "gold": {"forBmo": {"probabilities": {"true": 0.8, "false": 0.2}}}}]`;
    const reading = readJudgements(answer, items);

    expect(reading.refused).toBe(0);
    expect(reading.golds.get(row.id)?.forBmo).toEqual({
      type: "noul", label: "true", noul: 0.8, probabilities: { true: 0.8, false: 0.2 },
    });
  });

  test("reads an array the model wrapped in prose and a fence", () => {
    const answer = `판정했습니다.\n\`\`\`json\n[{"id": ${JSON.stringify(row.id)}, "gold": {"forBmo": {"probabilities": {"true": 0.1, "false": 0.9}}}}]\n\`\`\``;

    expect(readJudgements(answer, items).golds.get(row.id)?.forBmo?.label).toBe("false");
  });

  test("normalises probabilities that do not add to one", () => {
    const answer = `[{"id": ${JSON.stringify(row.id)}, "gold": {"forBmo": {"probabilities": {"true": 3, "false": 1}}}}]`;

    expect(readJudgements(answer, items).golds.get(row.id)?.forBmo).toEqual({
      type: "noul", label: "true", noul: 0.75, probabilities: { true: 0.75, false: 0.25 },
    });
  });

  test("refuses an item whose gold names an answer the question does not have", () => {
    const answer = `[{"id": ${JSON.stringify(row.id)}, "gold": {"forBmo": {"probabilities": {"yes": 1}}}}]`;
    const reading = readJudgements(answer, items);

    expect(reading.golds.size).toBe(0);
    expect(reading.refused).toBe(1);
  });

  test("counts an item the answer said nothing about", () => {
    expect(readJudgements("[]", items).refused).toBe(1);
  });

  test("takes no answer for an item it never asked about", () => {
    const answer = '[{"id": "somebody-else:0000", "gold": {"forBmo": {"probabilities": {"true": 1, "false": 0}}}}]';

    expect(readJudgements(answer, items).golds.size).toBe(0);
  });
});

describe("judgedRows", () => {
  test("freezes a judged row with its gold and keeps the split the input fixed", () => {
    const answer = `[{"id": ${JSON.stringify(row.id)}, "gold": {"forBmo": {"probabilities": {"true": 0.9, "false": 0.1}}}}]`;
    const outcome = judgedRows(spec, [row], readJudgements(answer, items), shares, "archive");

    expect(outcome.rows.length).toBe(1);
    expect(outcome.rows[0]!.row.split).toBe(row.split);
    expect(outcome.rows[0]!.row.id).toBe(row.id);
    expect(outcome.rows[0]!.source).toBe("archive");
    expect(JSON.parse(outcome.rows[0]!.row.gold)).toHaveProperty("forBmo");
  });

  test("keeps an English room's row, because a real row's language is a fact and not a target", () => {
    const english = rowOf("[2026-06-19T08:13:20.000Z] #5512 Nadia (id 3391044): thanks, that works");
    const answer = `[{"id": ${JSON.stringify(english.id)}, "gold": {"forBmo": {"probabilities": {"true": 0.2, "false": 0.8}}}}]`;
    const asked: JudgeItem[] = [{ id: english.id, state: english.state, questions: english.questions }];
    const outcome = judgedRows(spec, [english], readJudgements(answer, asked), shares, "archive");

    expect(outcome.rows.length).toBe(1);
  });

  test("refuses a row that does not answer its own gate and says why", () => {
    const broken = unjudgedRowOf("reply-wanted", { room: "group", recent: ["줄이 아닌 것"], message: "이것도 아니다" }, row.questions, shares);
    const answer = `[{"id": ${JSON.stringify(broken.id)}, "gold": {"forBmo": {"probabilities": {"true": 1, "false": 0}}}}]`;
    const asked: JudgeItem[] = [{ id: broken.id, state: broken.state, questions: broken.questions }];
    const outcome = judgedRows(spec, [broken], readJudgements(answer, asked), shares, "archive");

    expect(outcome.rows).toEqual([]);
    expect(outcome.refusals["wrong-transcript"]).toBe(1);
  });

  test("leaves an unanswered row out rather than guessing at it", () => {
    const outcome = judgedRows(spec, [row], readJudgements("[]", items), shares, "archive");

    expect(outcome.rows).toEqual([]);
    expect(outcome.unanswered).toBe(1);
  });
});

describe("judgeBatches", () => {
  const asking = (many: number, name: string): UnjudgedRow => ({
    id: `people-search:${name}`,
    gate: "people-search",
    split: "train",
    state: "말",
    questions: Object.fromEntries(Array.from({ length: many }, (_, at) => [
      `piece-${at}`,
      { type: "noul" as const, instructions: "이 대화에 답하려면 이 인물 기록이 필요한가?" },
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
