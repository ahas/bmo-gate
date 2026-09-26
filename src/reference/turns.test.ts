import { describe, expect, test } from "bun:test";

import { contextSlug, quietInstructions, readTurns, replyAfter } from "./turns";

import type { ArchivedMessage } from "../archive";
import type { RecordedPick, TurnReads, TurnScope } from "./turns";

const bmo = 900;
const chat = -7;

function said(messageId: number, senderId: number, sentAt: number, text = `말 ${messageId}`): ArchivedMessage {
  return { chatId: chat, messageId, senderId, senderName: senderId === bmo ? "BMO" : `사람${senderId}`, sentAt, text, imagePath: null, replyToMessageId: null };
}

type Scope = Pick<TurnScope, "run" | "chatId" | "messageIds"> & Partial<TurnScope>;

function reads(
  room: ArchivedMessage[],
  scopes: Scope[] = [],
  contexts = new Map<string, Set<string>>(),
  recorded = new Map<string, RecordedPick[]>(),
  answers = new Map<string, string[]>(),
): TurnReads {
  return {
    rooms: () => [chat],
    room: () => room,
    scopes: () => scopes.map((one) => ({ instructions: "", at: 0, ...one })),
    contexts: () => contexts,
    recorded: () => recorded,
    answers: () => answers,
  };
}

describe("replyAfter", () => {
  test("takes BMO's first run after the message, up to somebody else's next word", () => {
    const room = [said(1, 5, 0), said(2, bmo, 10, "하나"), said(3, bmo, 12, "둘"), said(4, 5, 20)];

    expect(replyAfter(room, 0, bmo)).toBe("하나\n\n둘");
  });

  test("finds none past the bound", () => {
    expect(replyAfter([said(1, 5, 0), said(2, bmo, 4_000)], 0, bmo)).toBeNull();
  });
});

describe("readTurns", () => {
  test("a turn run's scope names its messages exactly, and its context lines say what attached", () => {
    const room = [said(1, 5, 0), said(2, 6, 5), said(3, bmo, 20), said(4, 5, 100)];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [2, 1] }], new Map([["r1", new Set(["structure"])]])), bmo);

    expect(built.turns).toHaveLength(1);
    expect(built.turns[0]).toMatchObject({ key: `${chat}:2`, messageIds: [1, 2], source: "run", reply: "말 3" });
    expect([...built.turns[0]!.attached!]).toEqual(["structure"]);
    expect(built.turns[0]).not.toHaveProperty("instructions");
  });

  test("the instructions a turn run with messages was handed stand beside its messages", () => {
    const room = [said(1, 5, 0), said(2, bmo, 20)];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [1], instructions: "[배포 알림] 올라갔다" }]), bmo);

    expect(built.turns[0]).toMatchObject({ key: `${chat}:1`, source: "run", instructions: "[배포 알림] 올라갔다" });
  });

  test("an answered run before the room's first scope is rebuilt, its attachments unknown", () => {
    const room = [said(1, 5, 0), said(2, 6, 5), said(3, bmo, 20), said(4, 5, 1_000), said(5, bmo, 1_010)];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [4] }]), bmo);
    const answered = built.turns.find((turn) => turn.source === "answered")!;

    expect(answered).toMatchObject({ key: `${chat}:2`, messageIds: [1, 2], attached: null });
    expect(built.turns.map((turn) => turn.key)).toEqual([`${chat}:4`, `${chat}:2`]);
  });

  test("after a room's first scope, BMO speaking unasked is no turn", () => {
    const room = [said(1, 5, 0), said(2, bmo, 5), said(3, 5, 100), said(4, bmo, 110)];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [1] }]), bmo);

    expect(built.turns.map((turn) => turn.key)).toEqual([`${chat}:1`]);
  });

  test("a message the gates were asked about whose run left no scope is a turn on the record's word", () => {
    const room = [said(1, 5, 0), said(2, 5, 30), said(3, bmo, 40)];
    const picks: RecordedPick[] = [{ gate: "room-rules", slug: "quiet", llm: true, attached: true }];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [1, 2] }], new Map(), new Map([[`${chat}:1`, picks]])), bmo);
    const record = built.turns.find((turn) => turn.source === "record")!;

    expect(record).toMatchObject({ key: `${chat}:1`, messageIds: [1], recorded: picks });
    expect([...record.attached!]).toEqual(["quiet"]);
  });

  test("a run the bot's own instructions opened is a turn named by the run, answered by what the run said", () => {
    const room = [said(1, 5, 0), said(2, bmo, 5)];
    const opened = { run: "chat:-7:1:4", chatId: chat, messageIds: [], instructions: "[작업 실행 상태] #793 끝", at: 3_000 };
    const built = readTurns(reads(room, [opened], new Map([["chat:-7:1:4", new Set(["job-793"])]]), new Map(), new Map([["chat:-7:1:4", ["", "<<SKIP>>"]]])), bmo);
    const turn = built.turns.find((one) => one.source === "instructions")!;

    expect(turn).toMatchObject({ key: "chat:-7:1:4", messageIds: [], at: 3_000, reply: "<<SKIP>>", instructions: "[작업 실행 상태] #793 끝", recorded: [] });
    expect([...turn.attached!]).toEqual(["job-793"]);
    expect(built.turns[0]).toBe(turn);
  });

  test("a run the instructions opened that said nothing is counted with no reply, and a scope of neither is no turn", () => {
    const built = readTurns(reads([], [
      { run: "silent", chatId: chat, messageIds: [], instructions: "[배포 알림]" },
      { run: "empty", chatId: chat, messageIds: [] },
    ], new Map(), new Map(), new Map([["empty", ["말"]]])), bmo);

    expect(built.turns).toEqual([]);
    expect(built.skipped.noReply).toBe(1);
  });

  test("a turn with no reply inside the bound is left out and counted", () => {
    const built = readTurns(reads([said(1, 5, 0), said(2, bmo, 5_000)], [{ run: "r", chatId: chat, messageIds: [1] }]), bmo);

    expect(built.turns).toEqual([]);
    expect(built.skipped.noReply).toBe(1);
  });
});

describe("contextSlug", () => {
  test("reads a piece's slug off a path, and a root document's off its file name", () => {
    expect(contextSlug("/brain/rooms/-7/rules/quiet.md")).toBe("quiet");
    expect(contextSlug("STRUCTURE.md")).toBe("structure");
  });
});

describe("quietInstructions", () => {
  test("reads the instructions a turn prompt carries in its quiet-instruction block, whole", () => {
    const prompt = [
      'TURN SCOPE: {"chatId":-7,"messageIds":[],"referenceMessageIds":[]}',
      "Chat id: -7",
      "",
      "Quiet instruction from the system (2):",
      "[잡 끝남] #12",
      "",
      "second line",
      "END OF QUIET INSTRUCTION",
      "",
      "ANSWER LANGUAGE: Korean",
    ].join("\n");

    expect(quietInstructions(prompt)).toBe("[잡 끝남] #12\n\nsecond line");
  });

  test("a prompt with no block carries no instructions", () => {
    expect(quietInstructions("TURN SCOPE: {}\nNew messages (1):\nhi\nEND OF NEW MESSAGES")).toBe("");
  });
});
