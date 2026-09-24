import { describe, expect, test } from "bun:test";

import { splitOf } from "../laya-dataset";
import { pseudonyms } from "../pii";
import { labelKey } from "./labels";
import { answerCounts, emptyGateRows, fittingState, leaveRequest, leaveRoom, referenceRow, referenceRows, referenceShares } from "./rows";

import type { LayaRequest } from "../laya";
import type { Label } from "./labels";
import type { LiveGate } from "./live-inputs";

const owner = 90000001;
const bmo = 8_709_910_429;
const people = new Map([[owner, "ahas"], [51_078_230, "Creeper"], [bmo, "BMO"]]);
const names = () => pseudonyms("test", { ownerId: owner, bmoId: bmo });

const live = (slugs: string[]): LiveGate => ({
  gate: "people-search",
  held: slugs.length,
  capped: 0,
  candidates: slugs.map((slug) => ({ slug, about: `${slug} 기록` })),
  request: {
    state: `ahas (id ${owner}): 크리퍼 일 어떻게 돼 가\n두 번째 줄`,
    questions: Object.fromEntries(slugs.map((slug) => [slug, { type: "noul", instructions: `이 대화에 답하려면 이 인물 기록이 필요한가? 기록 ${slug}: ${slug} 기록` }])),
  },
});

const label = (turn: string, slug: string, word: Label["word"]): [string, Label] =>
  [labelKey(turn, "people-search", slug), { turn, gate: "people-search", slug, word, attached: false, batch: 0, at: "t" }];

describe("leaveRoom", () => {
  test("replaces a head's name and every sender number, and keeps BMO's name", () => {
    const held = names();
    const text = leaveRoom(`ahas (id ${owner}): p${owner}-work 봐\nBMO (id ${bmo}): 네`, held, people);

    expect(text).not.toContain("ahas");
    expect(text).not.toContain(String(owner));
    expect(text).toContain(`p${held.idOf(owner)}-work`);
    expect(text).toContain(`BMO (id ${held.idOf(bmo)}): 네`);
  });

  test("leaves a chat's own number and a date alone", () => {
    expect(leaveRoom("방 -1003874969077 에서 2026-09-24 에", names(), people)).toBe("방 -1003874969077 에서 2026-09-24 에");
  });
});

describe("leaveRequest", () => {
  test("rewrites a question's own name the way it rewrites its words", () => {
    const held = names();
    const left = leaveRequest(live([`p${owner}-work`]).request, held, people);

    expect(Object.keys(left.questions)).toEqual([`p${held.idOf(owner)}-work`]);
  });

  test("keeps an item number in a slug as the slug's word, in its name and in its question", () => {
    const slug = `p${owner}-todo-merge-679-812-3301`;
    const held = names();
    const left = leaveRequest(live([slug]).request, held, people);
    const renamed = `p${held.idOf(owner)}-todo-merge-679-812-3301`;

    expect(Object.keys(left.questions)).toEqual([renamed]);
    expect(left.questions[renamed]!.instructions).toContain(`기록 ${renamed}: ${renamed} 기록`);
  });
});

describe("fittingState", () => {
  test("keeps the newest whole messages that fit one call", () => {
    const request: LayaRequest = { state: `a (id 1): ${"가".repeat(900)}\n이어진 줄\nb (id 2): 짧은 말`, questions: { q: { type: "noul", instructions: "그런가?" } } };

    expect(fittingState(request)!.state).toBe("b (id 2): 짧은 말");
  });
});

describe("referenceRow", () => {
  const leave = (request: LayaRequest) => leaveRequest(request, names(), people);

  test("waits while any candidate has no label", () => {
    const into = emptyGateRows();

    referenceRow("-7:3", live(["a-one", "b-two"]), new Map([label("-7:3", "a-one", "needed")]), leave, into);

    expect(into.rows).toEqual([]);
    expect([into.waiting, into.unlabelled]).toEqual([1, 1]);
  });

  test("carries BMO's input with each gold beside its own question, split by the turn", () => {
    const into = emptyGateRows();

    referenceRow("-7:3", live(["a-one", "b-two"]), new Map([label("-7:3", "a-one", "needed"), label("-7:3", "b-two", "not-needed")]), leave, into);

    const row = into.rows[0]!;
    const gold = JSON.parse(row.gold) as Record<string, { noul: number }>;

    expect(into.refused).toEqual({});
    expect(row.split).toBe(splitOf("-7:3", referenceShares));
    expect(row.turn).toBe("-7:3");
    expect(Object.keys(JSON.parse(row.questions) as object)).toEqual(["a-one", "b-two"]);
    expect([gold["a-one"]!.noul, gold["b-two"]!.noul]).toEqual([0.95, 0.05]);
    expect(JSON.parse(row.state) as string).not.toContain("ahas");
  });
});

describe("a slug as long as BMO's writers made it", () => {
  test("is a question the gate asks", () => {
    const slug = "p90000001-agent-log-sqlite-postgres-schema-deep-dive";
    const into = emptyGateRows();

    referenceRow("-7:5", live([slug]), new Map([label("-7:5", slug, "needed")]), (request) => request, into);

    expect([into.rows.length, into.refused]).toEqual([1, {}]);
  });
});

describe("referenceRows", () => {
  test("keeps one row an input, the turn given first standing", () => {
    const labels = new Map([label("-7:3", "a-one", "used"), label("-7:4", "a-one", "unused")]);
    const built = referenceRows([{ key: "-7:3", gates: [live(["a-one"])] }, { key: "-7:4", gates: [live(["a-one"])] }], labels, (request) => request);

    expect(built["people-search"].rows.map((row) => row.turn)).toEqual(["-7:3"]);
    expect(built["system-documents"].rows).toEqual([]);
    expect(answerCounts(built["people-search"].rows)).toEqual({ rows: 1, rowsWithYes: 1, yes: 1, no: 0, contested: 0 });
  });
});
