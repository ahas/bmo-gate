import { describe, expect, test } from "bun:test";

import { splitOf } from "../../../training/tooling/src/laya-dataset";
import { pseudonyms } from "../../../training/tooling/src/pii";
import { labelKey } from "../../../training/tooling/src/reference/labels";
import { answerCounts, emptyGateRows, fittingState, leaveRequest, leaveRoom, referenceRows, referenceShares, referenceTurnRows } from "../../../training/tooling/src/reference/rows";

import type { LayaRequest } from "../../../training/tooling/src/laya";
import type { Label } from "../../../training/tooling/src/reference/labels";
import type { LiveGate } from "../../../training/tooling/src/reference/live-inputs";
import { useToolingSettings } from "../settings";

useToolingSettings();

const owner = 10_000_001;
const agent = 8_709_910_429;
const people = new Map([[owner, "Owner"], [50_000_005, "Grace"], [agent, "Robin"]]);
const names = () => pseudonyms("test", { ownerId: owner, agentId: agent });

const live = (slugs: string[]): LiveGate => ({
  gate: "people-search",
  held: slugs.length,
  capped: 0,
  candidates: slugs.map((slug) => ({ slug, about: `${slug} \uAE30\uB85D` })),
  request: {
    state: `Owner (id ${owner}): \uADF8 \uC77C \uC5B4\uB5BB\uAC8C \uB3FC \uAC00\n\uB450 \uBC88\uC9F8 \uC904`,
    questions: Object.fromEntries(slugs.map((slug) => [slug, { type: "noul", instructions: `\uC774 \uB300\uD654\uC5D0 \uB2F5\uD558\uB824\uBA74 \uC774 \uC778\uBB3C \uAE30\uB85D\uC774 \uD544\uC694\uD55C\uAC00? \uAE30\uB85D ${slug}: ${slug} \uAE30\uB85D` }])),
  },
});

const label = (turn: string, slug: string, word: Label["word"]): [string, Label] =>
  [labelKey(turn, "people-search", slug), { turn, gate: "people-search", slug, word, attached: false, batch: 0, at: "t" }];

describe("leaveRoom", () => {
  test("replaces a head's name and every sender number, and keeps the chat agent's name", () => {
    const held = names();
    const text = leaveRoom(`Owner (id ${owner}): p${owner}-work \uBD10\nRobin (id ${agent}): \uB124`, held, people);

    expect(text).not.toContain("Owner");
    expect(text).not.toContain(String(owner));
    expect(text).toContain(`p${held.idOf(owner)}-work`);
    expect(text).toContain(`Robin (id ${held.idOf(agent)}): \uB124`);
  });

  test("leaves a chat's own number and a date alone", () => {
    expect(leaveRoom("\uBC29 -1000000000003 \uC5D0\uC11C 2026-09-24 \uC5D0", names(), people)).toBe("\uBC29 -1000000000003 \uC5D0\uC11C 2026-09-24 \uC5D0");
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
    expect(left.questions[renamed]!.instructions).toContain(`\uAE30\uB85D ${renamed}: ${renamed} \uAE30\uB85D`);
  });
});

describe("fittingState", () => {
  test("keeps the newest whole messages that fit one call", () => {
    const request: LayaRequest = { state: `a (id 1): ${"\uAC00".repeat(900)}\n\uC774\uC5B4\uC9C4 \uC904\nb (id 2): \uC9E7\uC740 \uB9D0`, questions: { q: { type: "noul", instructions: "\uADF8\uB7F0\uAC00?" } } };

    expect(fittingState(request)!.state).toBe("b (id 2): \uC9E7\uC740 \uB9D0");
  });
});

describe("referenceTurnRows", () => {
  const leave = (request: LayaRequest) => leaveRequest(request, names(), people);

  test("carries the labelled candidates and leaves out the one with no label yet", () => {
    const into = emptyGateRows();

    referenceTurnRows("-7:3", live(["a-one", "b-two", "c-three"]), new Map([label("-7:3", "a-one", "needed"), label("-7:3", "c-three", "not-needed")]), leave, into, "turn");

    const gold = JSON.parse(into.rows[0]!.gold) as Record<string, { noul: number }>;

    expect(Object.keys(JSON.parse(into.rows[0]!.questions) as object)).toEqual(["a-one", "c-three"]);
    expect([gold["a-one"]!.noul, gold["c-three"]!.noul]).toEqual([0.95, 0.05]);
    expect([into.waiting, into.unlabelled]).toEqual([0, 1]);
  });

  test("waits while no candidate has a label", () => {
    const into = emptyGateRows();

    referenceTurnRows("-7:3", live(["a-one", "b-two"]), new Map(), leave, into, "turn");

    expect(into.rows).toEqual([]);
    expect([into.waiting, into.unlabelled]).toEqual([1, 2]);
  });

  test("carries the gate's input with each gold beside its own question, split by the turn", () => {
    const into = emptyGateRows();

    referenceTurnRows("-7:3", live(["a-one", "b-two"]), new Map([label("-7:3", "a-one", "needed"), label("-7:3", "b-two", "not-needed")]), leave, into, "turn");

    const row = into.rows[0]!;
    const gold = JSON.parse(row.gold) as Record<string, { noul: number }>;

    expect(into.refused).toEqual({});
    expect(row.split).toBe(splitOf("-7:3", referenceShares));
    expect(row.turn).toBe("-7:3");
    expect(Object.keys(JSON.parse(row.questions) as object)).toEqual(["a-one", "b-two"]);
    expect([gold["a-one"]!.noul, gold["b-two"]!.noul]).toEqual([0.95, 0.05]);
    expect(JSON.parse(row.state) as string).not.toContain("Owner");
  });
});

describe("a turn of more candidates than one call holds", () => {
  const slugs = Array.from({ length: 300 }, (_, at) => `piece-${at}`);
  const labelled = (skip: string | null) =>
    new Map(slugs.filter((slug) => slug !== skip).map((slug) => label("-7:6", slug, slug === "piece-200" ? "needed" : "not-needed")));

  test("is a row for each call the gate's client asks it in, its questions in order under one state", () => {
    const into = emptyGateRows();

    referenceTurnRows("-7:6", live(slugs), labelled(null), (request) => request, into, "turn");

    const questions = into.rows.map((row) => Object.keys(JSON.parse(row.questions) as object));
    const gold = JSON.parse(into.rows[1]!.gold) as Record<string, { noul: number }>;

    expect(into.refused).toEqual({});
    expect(questions.map((ids) => ids.length)).toEqual([128, 128, 44]);
    expect(questions.flat()).toEqual(slugs);
    expect(new Set(into.rows.map((row) => row.state)).size).toBe(1);
    expect(new Set(into.rows.map((row) => row.split))).toEqual(new Set([splitOf("-7:6", referenceShares)]));
    expect([gold["piece-200"]!.noul, gold["piece-199"]!.noul]).toEqual([0.95, 0.05]);
  });

  test("leaves a candidate with no label out of its own call's row alone", () => {
    const into = emptyGateRows();

    referenceTurnRows("-7:6", live(slugs), labelled("piece-299"), (request) => request, into, "turn");

    expect(into.rows.map((row) => Object.keys(JSON.parse(row.questions) as object).length)).toEqual([128, 128, 43]);
    expect([into.waiting, into.unlabelled]).toEqual([0, 1]);
  });
});

describe("a slug as long as the brain's writers made it", () => {
  test("is a question the gate asks", () => {
    const slug = "p10000001-agent-log-sqlite-postgres-schema-deep-dive";
    const into = emptyGateRows();

    referenceTurnRows("-7:5", live([slug]), new Map([label("-7:5", slug, "needed")]), (request) => request, into, "turn");

    expect([into.rows.length, into.refused]).toEqual([1, {}]);
  });
});

describe("referenceRows", () => {
  test("keeps one row an input, the turn given first standing", () => {
    const labels = new Map([label("-7:3", "a-one", "used"), label("-7:4", "a-one", "unused")]);
    const built = referenceRows([{ key: "-7:3", source: "record", gates: [live(["a-one"])] }, { key: "-7:4", source: "record", gates: [live(["a-one"])] }], labels, (request) => request);

    expect(built["people-search"].rows.map((row) => row.turn)).toEqual(["-7:3"]);
    expect(built["system-documents"].rows).toEqual([]);
    expect(answerCounts(built["people-search"].rows)).toEqual({ rows: 1, rowsWithYes: 1, yes: 1, no: 0, contested: 0 });
  });

  test("names a job's or a search's rows work and every other turn's rows turn", () => {
    const labels = new Map([label("job:9", "a-one", "needed"), label("-7:3", "a-one", "not-needed"), label("-7:3", "b-two", "not-needed")]);
    const built = referenceRows([{ key: "job:9", source: "work", gates: [live(["a-one"])] }, { key: "-7:3", source: "answered", gates: [live(["a-one", "b-two"])] }], labels, (request) => request);

    expect(built["people-search"].rows.map((row) => [row.turn, row.stratum])).toEqual([["job:9", "work"], ["-7:3", "turn"]]);
  });
});
