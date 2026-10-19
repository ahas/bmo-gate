import { describe, expect, test } from "bun:test";

import { foldState } from "../../training/tooling/src/fold-state";
import { inTranscriptShape, languageOf, stateText, synthesisFor, validateSynthRow } from "../../training/tooling/src/laya-synth";
import { pseudonyms } from "../../training/tooling/src/pii";
import {
  candidateSetsByRoom, newestFitting, offeredSets, outputFormatRows, realRows,
  realSourceGates, replyWantedRows, situationRows, unjudgedRowOf,
} from "../../training/tooling/src/real-rows";

import type { ArchivedMessage } from "../../training/tooling/src/conversation";
import type { LayaQuestion } from "../../training/tooling/src/laya";
import type { ConversationReads, RealSettings } from "../../training/tooling/src/real-rows";
import { useToolingSettings } from "./settings";

useToolingSettings();

const ownerId = 10_000_001;
const agentId = 8_709_910_429;
const shares = { calibration: 0.15, test: 0.15 };

function settings(over: Partial<RealSettings> = {}): RealSettings {
  return {
    who: { ownerId, agentId, names: pseudonyms("test", { ownerId, agentId }) },
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
  said(50_000_005, "Grace", "\uC624\uB298 \uC800\uB141\uC5D0 \uB2E4\uB4E4 \uC2DC\uAC04 \uB418\uB098"),
  said(ownerId, "Owner", "\uB098\uB294 \uC77C\uACF1 \uC2DC \uC774\uD6C4"),
  said(agentId, "Robin", "\uC77C\uACF1 \uC2DC\uB85C \uC7A1\uC544 \uB458\uAE4C\uC694?"),
  said(50_000_005, "Grace", "Robin\uC57C \uADF8\uB807\uAC8C \uD574 \uC918"),
  said(30_000_003, "Carol", "\uB098\uB3C4 \uC88B\uC544"),
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

  test("judges nobody's message but a person's, and leaves the chat agent's own out of the judging", () => {
    const rows = replyWantedRows(room, settings());

    for (const row of rows) {
      expect((row.state as { message: string }).message).not.toContain("\uC77C\uACF1 \uC2DC\uB85C \uC7A1\uC544 \uB458\uAE4C\uC694?");
    }
  });

  test("keeps the chat agent's own lines standing among the recent ones, which is the case it has to judge", () => {
    const rows = replyWantedRows(room, settings());
    const lines = rows.flatMap((row) => (row.state as { recent: string[] }).recent);

    expect(lines.some((line) => line.includes("\uC77C\uACF1 \uC2DC\uB85C \uC7A1\uC544 \uB458\uAE4C\uC694?"))).toBe(true);
  });

  test("names the owner's line with the owner tag and nobody else's", () => {
    const lines = replyWantedRows(room, settings()).flatMap((row) => (row.state as { recent: string[] }).recent);
    const owner = lines.filter((line) => line.includes(", OWNER"));

    expect(owner.length).toBeGreaterThan(0);
    expect(owner.every((line) => line.includes("\uC77C\uACF1 \uC2DC \uC774\uD6C4"))).toBe(true);
  });

  test("builds no row for a turn with nothing in front of it", () => {
    expect(replyWantedRows([room[0]!], settings())).toEqual([]);
  });

  test("stops at the rows it was asked for", () => {
    expect(replyWantedRows(room, settings({ limit: 1 })).length).toBe(1);
  });
});

describe("outputFormatRows", () => {
  test("the gate is shown the message reduced, and the judge reads the markdown whole", () => {
    const original = "**\uACB0\uB860**: \uB410\uC5B4\uC694\n\n\uB098\uBA38\uC9C0\uB294 \uB0B4\uC77C \uBCFC\uAC8C\uC694.";
    const rows = outputFormatRows([{ original, visible: "\uACB0\uB860: \uB410\uC5B4\uC694\n\n\uB098\uBA38\uC9C0\uB294 \uB0B4\uC77C \uBCFC\uAC8C\uC694.", folded: true }], settings());

    expect(rows[0]!.state).toEqual(foldState(original));
    expect(rows[0]!.teacher).toEqual({ message: original });
    expect(Object.keys(rows[0]!.questions)).toEqual(["fold"]);
  });

  test("a message far past one call's reach is still a row", () => {
    const original = "\uAE34 \uB2F5\uC758 \uD55C \uC904\uC774\uC5D0\uC694.\n".repeat(400);

    expect(outputFormatRows([{ original, visible: original, folded: true }], settings())).toHaveLength(1);
  });

  test("leaves out what never reaches the gate: no markdown, or one short line", () => {
    expect(outputFormatRows([{ original: "   ", visible: "x", folded: false }], settings())).toEqual([]);
    expect(outputFormatRows([{ original: "\uB124, \uC54C\uACA0\uC5B4\uC694.", visible: "\uB124, \uC54C\uACA0\uC5B4\uC694.", folded: false }], settings())).toEqual([]);
  });
});

// A room's standing rules as the situation-rule matcher is offered them: two questions of each.
function rulesOf(many: number): Record<string, LayaQuestion> {
  return Object.fromEntries(Array.from({ length: many }, (_, at) => [
    [`rule-${at}:applies`, { type: "noul" as const, instructions: `\uC774 \uADDC\uCE59\uC758 \uC870\uAC74\uC774 \uC9C0\uAE08 \uC0C1\uD669\uC5D0 \uB9DE\uB294\uAC00? \uADDC\uCE59 rule-${at}: \uC800\uB141 \uC57D\uC18D\uC774 \uC7A1\uD788\uBA74 \uC54C\uB824 \uC900\uB2E4` }],
    [`rule-${at}:spent`, { type: "noul" as const, instructions: `\uC774 \uADDC\uCE59\uC740 \uC774\uC81C \uC548 \uC368\uB3C4 \uB418\uB294\uAC00? \uADDC\uCE59 rule-${at}: \uC800\uB141 \uC57D\uC18D\uC774 \uC7A1\uD788\uBA74 \uC54C\uB824 \uC900\uB2E4` }],
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
      "evening-plan:applies": { type: "noul", instructions: "\uC774 \uADDC\uCE59\uC758 \uC870\uAC74\uC774 \uC9C0\uAE08 \uC0C1\uD669\uC5D0 \uB9DE\uB294\uAC00? \uADDC\uCE59 evening-plan: \uC800\uB141 \uC57D\uC18D\uC774 \uC7A1\uD788\uBA74 \uC54C\uB824 \uC900\uB2E4" },
      "evening-plan:spent": { type: "noul", instructions: "\uC774 \uADDC\uCE59\uC740 \uC774\uC81C \uC548 \uC368\uB3C4 \uB418\uB294\uAC00? \uADDC\uCE59 evening-plan: \uC800\uB141 \uC57D\uC18D\uC774 \uC7A1\uD788\uBA74 \uC54C\uB824 \uC900\uB2E4" },
    };
    const rows = situationRows(room, [rules], settings());
    const state = rows[0]!.state as { room: string; situation: string[] };

    expect(rows.length).toBeGreaterThan(0);
    expect(inTranscriptShape("room", state.situation.join("\n"))).toBe(true);
  });
});

describe("unjudgedRowOf", () => {
  test("names a row by its own input, so one input is one row however often it is met", () => {
    const one = unjudgedRowOf("reply-wanted", "\uB9D0", { forAgent: { type: "noul", instructions: "\uC774 \uBA54\uC2DC\uC9C0\uB294 Robin\uC5D0\uAC8C \uD55C \uB9D0\uC778\uAC00?" } }, shares);
    const again = unjudgedRowOf("reply-wanted", "\uB9D0", { forAgent: { type: "noul", instructions: "\uC774 \uBA54\uC2DC\uC9C0\uB294 Robin\uC5D0\uAC8C \uD55C \uB9D0\uC778\uAC00?" } }, shares);

    expect(one.id).toBe(again.id);
    expect(one.split).toBe(again.split);
  });
});

describe("newestFitting", () => {
  test("keeps the newest lines and leaves the oldest out", () => {
    const kept = newestFitting(["\uAC00".repeat(900), "\uB098", "\uB2E4"], (lines) => ({
      state: lines.join("\n"),
      questions: { one: { type: "noul", instructions: "\uADF8\uB7F0\uAC00?" } },
    }));

    expect(kept).toEqual(["\uB098", "\uB2E4"]);
  });
});

describe("realRows", () => {
  const reads: ConversationReads = {
    rooms: () => [-1_000],
    messages: () => room,
    recorded: () => [{ chatId: -1_000, questions: rulesOf(3) }],
    sent: () => [{ original: "**\uACB0\uB860**: \uB410\uC5B4\uC694", visible: "\uACB0\uB860: \uB410\uC5B4\uC694", folded: false }],
  };

  test("answers for every gate it was asked about, empty ones included", () => {
    const built = realRows(reads, settings(), [...realSourceGates]);

    expect([...built.keys()].sort()).toEqual([...realSourceGates].sort());
  });

  test("builds no reference gate, whose rows are made from the chat agent's own inputs", () => {
    expect(realSourceGates.some((gate) => ["system-documents", "room-rules", "library-knowledge", "people-search"].includes(gate))).toBe(false);
  });

  test("offers a gate no more candidates than that gate says it offers", () => {
    const many: ConversationReads = { ...reads, recorded: () => [{ chatId: -1_000, questions: rulesOf(30) }] };
    const rows = realRows(many, settings(), ["situation-rules"]).get("situation-rules")!;
    const range = synthesisFor("situation-rules")!.candidates!;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Object.keys(row.questions).length <= range.max * 2)).toBe(true);
    expect(rows.every((row) => Object.keys(row.questions).length >= range.min * 2)).toBe(true);
  });

  test("every row it builds answers its own gate once a gold is on it", () => {
    const built = realRows(reads, settings(), ["reply-wanted", "situation-rules"]);

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
