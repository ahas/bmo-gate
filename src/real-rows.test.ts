import { describe, expect, test } from "bun:test";

import { foldState } from "./fold-state";
import { inTranscriptShape, languageOf, stateText, synthesisFor, validateSynthRow } from "./laya-synth";
import { pseudonyms } from "./pii";
import {
  candidateSetsByRoom, contentJudgeRows, newestFitting, offeredSets, outputFormatRows, realRows,
  realSourceGates, replyWantedRows, situationRows, unjudgedRowOf,
} from "./real-rows";

import type { ArchivedMessage } from "./archive";
import type { LayaQuestion } from "./laya";
import type { ArchiveReads, RealSettings } from "./real-rows";

const ownerId = 90000001;
const bmoId = 8_709_910_429;
const shares = { calibration: 0.15, test: 0.15 };

function settings(over: Partial<RealSettings> = {}): RealSettings {
  return {
    who: { ownerId, bmoId, names: pseudonyms("test", { ownerId, bmoId }) },
    shares,
    limit: 100,
    ...over,
  };
}

let nextId = 100;

function said(senderId: number, senderName: string, text: string, over: Partial<ArchivedMessage> = {}): ArchivedMessage {
  nextId += 1;

  return {
    chatId: -1_000,
    messageId: nextId,
    senderId,
    senderName,
    sentAt: 1_780_000_000 + nextId,
    text,
    imagePath: null,
    replyToMessageId: null,
    ...over,
  };
}

const room: ArchivedMessage[] = [
  said(51_078_230, "Creeper", "오늘 저녁에 다들 시간 되나"),
  said(ownerId, "ahas", "나는 일곱 시 이후"),
  said(bmoId, "BMO", "일곱 시로 잡아 둘까요?"),
  said(51_078_230, "Creeper", "비모야 그렇게 해 줘"),
  said(29_071_912, "정수 배", "나도 좋아"),
];

describe("replyWantedRows", () => {
  test("hands the message over apart from the ones before it, in the room shape", () => {
    const rows = replyWantedRows(room, settings());
    const state = rows[0]!.state as { room: string; recent: string[]; message: string };

    expect(rows.length).toBeGreaterThan(0);
    expect(state.room).toBe("group");
    expect(state.recent.length).toBeGreaterThan(0);
    expect(inTranscriptShape("room", [...state.recent, state.message].join("\n"))).toBe(true);
  });

  test("judges nobody's message but a person's, and leaves BMO's own out of the judging", () => {
    const rows = replyWantedRows(room, settings());

    for (const row of rows) {
      expect((row.state as { message: string }).message).not.toContain("일곱 시로 잡아 둘까요?");
    }
  });

  test("keeps BMO's own lines standing among the recent ones, which is the case it has to judge", () => {
    const rows = replyWantedRows(room, settings());
    const lines = rows.flatMap((row) => (row.state as { recent: string[] }).recent);

    expect(lines.some((line) => line.includes("일곱 시로 잡아 둘까요?"))).toBe(true);
  });

  test("names the owner's line with the owner tag and nobody else's", () => {
    const lines = replyWantedRows(room, settings()).flatMap((row) => (row.state as { recent: string[] }).recent);
    const owner = lines.filter((line) => line.includes(", OWNER"));

    expect(owner.length).toBeGreaterThan(0);
    expect(owner.every((line) => line.includes("일곱 시 이후"))).toBe(true);
  });

  test("builds no row for a turn with nothing in front of it", () => {
    expect(replyWantedRows([room[0]!], settings())).toEqual([]);
  });

  test("stops at the rows it was asked for", () => {
    expect(replyWantedRows(room, settings({ limit: 1 })).length).toBe(1);
  });
});

describe("contentJudgeRows", () => {
  test("takes BMO's own answer as the candidate and the room in front of it as the context", () => {
    const rows = contentJudgeRows(room, settings());
    const state = rows[0]!.state as { room: string; recent: string[]; answer: string };

    expect(rows.length).toBe(1);
    expect(state.answer).toBe("일곱 시로 잡아 둘까요?");
    expect(state.recent.length).toBeGreaterThan(0);
  });

  test("builds no row in 하스's private chat, where the gate never stands", () => {
    const own = room.map((one) => ({ ...one, chatId: ownerId }));

    expect(contentJudgeRows(own, settings())).toEqual([]);
  });

  test("leaves out what answered no person's words: a line after BMO's own, or one past the turn's gap", () => {
    const answered = said(51_078_230, "Creeper", "비모야 내일 일정 알려 줘");
    const reply = said(bmoId, "BMO", "내일은 열 시에 모여요.", { sentAt: answered.sentAt + 5 });
    const report = said(bmoId, "BMO", "빌드 끝났어요.", { sentAt: reply.sentAt + 5 });
    const notice = said(bmoId, "BMO", "점검 알림이에요.", { sentAt: report.sentAt + 3_600 });
    const late = said(29_071_912, "정수 배", "고마워", { sentAt: notice.sentAt + 5 });
    const stale = said(bmoId, "BMO", "하루 지난 알림이에요.", { sentAt: late.sentAt + 86_400 });
    const answers = contentJudgeRows([...room, answered, reply, report, notice, late, stale], settings())
      .map((row) => (row.state as { answer: string }).answer);

    expect(answers).toEqual(["일곱 시로 잡아 둘까요?", "내일은 열 시에 모여요."]);
  });
});

describe("outputFormatRows", () => {
  test("the gate is shown the message reduced, and the judge reads the markdown whole", () => {
    const original = "**결론**: 됐어요\n\n나머지는 내일 볼게요.";
    const rows = outputFormatRows([{ original, visible: "결론: 됐어요\n\n나머지는 내일 볼게요.", folded: true }], settings());

    expect(rows[0]!.state).toEqual(foldState(original));
    expect(rows[0]!.teacher).toEqual({ message: original });
    expect(Object.keys(rows[0]!.questions)).toEqual(["fold"]);
  });

  test("a message far past one call's reach is still a row", () => {
    const original = "긴 답의 한 줄이에요.\n".repeat(400);

    expect(outputFormatRows([{ original, visible: original, folded: true }], settings())).toHaveLength(1);
  });

  test("leaves out what never reaches the gate: no markdown, or one short line", () => {
    expect(outputFormatRows([{ original: "   ", visible: "x", folded: false }], settings())).toEqual([]);
    expect(outputFormatRows([{ original: "네, 알겠어요.", visible: "네, 알겠어요.", folded: false }], settings())).toEqual([]);
  });
});

// A room's standing rules as the situation-rule matcher is offered them: two questions of each.
function rulesOf(many: number): Record<string, LayaQuestion> {
  return Object.fromEntries(Array.from({ length: many }, (_, at) => [
    [`rule-${at}:applies`, { type: "noul" as const, instructions: `이 규칙의 조건이 지금 상황에 맞는가? 규칙 rule-${at}: 저녁 약속이 잡히면 알려 준다` }],
    [`rule-${at}:spent`, { type: "noul" as const, instructions: `이 규칙은 이제 안 써도 되는가? 규칙 rule-${at}: 저녁 약속이 잡히면 알려 준다` }],
  ]).flat());
}

describe("offeredSets", () => {
  const situation = synthesisFor("situation-rules")!;

  test("cuts a set past what the gate offers into sets the gate accepts, counting candidates rather than questions", () => {
    const sets = offeredSets(situation, rulesOf(24));

    expect(sets.length).toBe(3);
    expect(sets.every((set) => Object.keys(set).length === situation.candidates!.max * 2)).toBe(true);
  });

  test("offers nothing where the room was recorded offering fewer than the gate's least", () => {
    expect(offeredSets(situation, rulesOf(1))).toEqual([]);
  });

  test("reaches back over the group before it rather than dropping a short remainder", () => {
    const sets = offeredSets(situation, rulesOf(17));

    expect(sets.map((set) => Object.keys(set).length)).toEqual([16, 16, 4]);
    expect(Object.keys(sets[2]!)).toEqual(["rule-15:applies", "rule-15:spent", "rule-16:applies", "rule-16:spent"]);
  });
});

describe("candidateSetsByRoom", () => {
  test("keeps a room's sets under the room that was offered them, cut to what the gate offers", () => {
    const byRoom = candidateSetsByRoom(synthesisFor("situation-rules")!, [{ chatId: -1_000, questions: rulesOf(16) }]);

    expect(byRoom.get(-1_000)!.length).toBe(2);
  });
});

describe("situationRows", () => {
  test("reads the situation in the room shape, which is what a condition's moment is read off", () => {
    const rules: Record<string, LayaQuestion> = {
      "evening-plan:applies": { type: "noul", instructions: "이 규칙의 조건이 지금 상황에 맞는가? 규칙 evening-plan: 저녁 약속이 잡히면 알려 준다" },
      "evening-plan:spent": { type: "noul", instructions: "이 규칙은 이제 안 써도 되는가? 규칙 evening-plan: 저녁 약속이 잡히면 알려 준다" },
    };
    const rows = situationRows(room, [rules], settings());
    const state = rows[0]!.state as { room: string; situation: string[] };

    expect(rows.length).toBeGreaterThan(0);
    expect(inTranscriptShape("room", state.situation.join("\n"))).toBe(true);
  });
});

describe("unjudgedRowOf", () => {
  test("names a row by its own input, so one input is one row however often it is met", () => {
    const one = unjudgedRowOf("reply-wanted", "말", { forBmo: { type: "noul", instructions: "이 메시지는 비모에게 한 말인가?" } }, shares);
    const again = unjudgedRowOf("reply-wanted", "말", { forBmo: { type: "noul", instructions: "이 메시지는 비모에게 한 말인가?" } }, shares);

    expect(one.id).toBe(again.id);
    expect(one.split).toBe(again.split);
  });
});

describe("newestFitting", () => {
  test("keeps the newest lines and leaves the oldest out", () => {
    const kept = newestFitting(["가".repeat(900), "나", "다"], (lines) => ({
      state: lines.join("\n"),
      questions: { one: { type: "noul", instructions: "그런가?" } },
    }));

    expect(kept).toEqual(["나", "다"]);
  });
});

describe("realRows", () => {
  const reads: ArchiveReads = {
    rooms: () => [-1_000],
    messages: () => room,
    recorded: () => [{ chatId: -1_000, questions: rulesOf(3) }],
    sent: () => [{ original: "**결론**: 됐어요", visible: "결론: 됐어요", folded: false }],
  };

  test("answers for every gate it was asked about, empty ones included", () => {
    const built = realRows(reads, settings(), [...realSourceGates]);

    expect([...built.keys()].sort()).toEqual([...realSourceGates].sort());
  });

  test("builds no reference gate, whose rows are made from BMO's own inputs", () => {
    expect(realSourceGates.some((gate) => ["system-documents", "room-rules", "library-knowledge", "people-search"].includes(gate))).toBe(false);
  });

  test("offers a gate no more candidates than that gate says it offers", () => {
    const many: ArchiveReads = { ...reads, recorded: () => [{ chatId: -1_000, questions: rulesOf(30) }] };
    const rows = realRows(many, settings(), ["situation-rules"]).get("situation-rules")!;
    const range = synthesisFor("situation-rules")!.candidates!;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Object.keys(row.questions).length <= range.max * 2)).toBe(true);
    expect(rows.every((row) => Object.keys(row.questions).length >= range.min * 2)).toBe(true);
  });

  test("every row it builds answers its own gate once a gold is on it", () => {
    const built = realRows(reads, settings(), ["reply-wanted", "content-judge", "situation-rules"]);

    for (const [gate, rows] of built) {
      const spec = synthesisFor(gate)!;

      for (const row of rows) {
        const gold = Object.fromEntries(Object.keys(row.questions).map((id) => [
          id,
          { type: "noul" as const, label: "true" as const, noul: 0.9, probabilities: { true: 0.9, false: 0.1 } },
        ]));
        const verdict = validateSynthRow(spec, { state: row.state, questions: row.questions, gold }, languageOf(stateText(spec, row.state)));

        expect(verdict.ok ? "ok" : `${gate}: ${verdict.refusal} — ${verdict.detail}`).toBe("ok");
      }
    }
  });
});
