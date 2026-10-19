import { describe, expect, test } from "bun:test";

import { contextSlug, quietInstructions, readTurns, replyAfter } from "../../../training/tooling/src/reference/turns";

import type { ArchivedMessage } from "../../../training/tooling/src/conversation";
import type { RecordedPick, TurnReads, TurnScope, WorkRecord } from "../../../training/tooling/src/reference/turns";
import { useToolingSettings } from "../settings";

useToolingSettings();

const agent = 900;
const chat = -7;

function said(messageId: number, senderId: number, sentAt: number, text = `\uB9D0 ${messageId}`): ArchivedMessage {
  return { chatId: chat, messageId, senderId, senderName: senderId === agent ? "Robin" : `\uC0AC\uB78C${senderId}`, sentAt, text, imagePath: null, replyToMessageId: null };
}

type Scope = Pick<TurnScope, "run" | "chatId" | "messageIds"> & Partial<TurnScope>;

function reads(
  room: ArchivedMessage[],
  scopes: Scope[] = [],
  contexts = new Map<string, Set<string>>(),
  recorded = new Map<string, RecordedPick[]>(),
  answers = new Map<string, string[]>(),
  works: WorkRecord[] = [],
): TurnReads {
  return {
    rooms: () => [chat],
    room: () => room,
    scopes: () => scopes.map((one) => ({ instructions: "", at: 0, ...one })),
    contexts: () => contexts,
    recorded: () => recorded,
    answers: () => answers,
    works: () => works,
  };
}

describe("replyAfter", () => {
  test("takes the chat agent's first run after the message, up to somebody else's next word", () => {
    const room = [said(1, 5, 0), said(2, agent, 10, "\uD558\uB098"), said(3, agent, 12, "\uB458"), said(4, 5, 20)];

    expect(replyAfter(room, 0, agent)).toBe("\uD558\uB098\n\n\uB458");
  });

  test("finds none past the bound", () => {
    expect(replyAfter([said(1, 5, 0), said(2, agent, 4_000)], 0, agent)).toBeNull();
  });
});

describe("readTurns", () => {
  test("a finished job and search are turns of their own, judged with the two words, and one with no reply is skipped", () => {
    const job: WorkRecord = { key: "job:12", chatId: chat, at: 300, reply: "Done: the server answers.", work: { kind: "job", title: "A server", instruction: "Build it.", requester: "owner", requesterId: 5 } };
    const search: WorkRecord = { key: "search:4", chatId: chat, at: 200, reply: "# Findings", work: { kind: "search", query: "release notes" } };
    const empty: WorkRecord = { key: "search:5", chatId: chat, at: 100, reply: " ", work: { kind: "search", query: "nothing" } };
    const built = readTurns(reads([], [], new Map(), new Map(), new Map(), [job, search, empty]), agent);

    expect(built.turns.map((one) => one.key)).toEqual(["job:12", "search:4"]);
    expect(built.turns[0]).toMatchObject({ source: "work", messageIds: [], attached: null, reply: "Done: the server answers.", work: job.work });
    expect(built.skipped.noReply).toBe(1);
  });
  test("a turn run's scope names its messages exactly, and its context lines say what attached", () => {
    const room = [said(1, 5, 0), said(2, 6, 5), said(3, agent, 20), said(4, 5, 100)];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [2, 1] }], new Map([["r1", new Set(["structure"])]])), agent);

    expect(built.turns).toHaveLength(1);
    expect(built.turns[0]).toMatchObject({ key: `${chat}:2`, messageIds: [1, 2], source: "run", reply: "\uB9D0 3" });
    expect([...built.turns[0]!.attached!]).toEqual(["structure"]);
    expect(built.turns[0]).not.toHaveProperty("instructions");
  });

  test("the instructions a turn run with messages was handed stand beside its messages", () => {
    const room = [said(1, 5, 0), said(2, agent, 20)];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [1], instructions: "[\uBC30\uD3EC \uC54C\uB9BC] \uC62C\uB77C\uAC14\uB2E4" }]), agent);

    expect(built.turns[0]).toMatchObject({ key: `${chat}:1`, source: "run", instructions: "[\uBC30\uD3EC \uC54C\uB9BC] \uC62C\uB77C\uAC14\uB2E4" });
  });

  test("an answered run before the room's first scope is rebuilt, its attachments unknown", () => {
    const room = [said(1, 5, 0), said(2, 6, 5), said(3, agent, 20), said(4, 5, 1_000), said(5, agent, 1_010)];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [4] }]), agent);
    const answered = built.turns.find((turn) => turn.source === "answered")!;

    expect(answered).toMatchObject({ key: `${chat}:2`, messageIds: [1, 2], attached: null });
    expect(built.turns.map((turn) => turn.key)).toEqual([`${chat}:4`, `${chat}:2`]);
  });

  test("after a room's first scope, the chat agent speaking unasked is no turn", () => {
    const room = [said(1, 5, 0), said(2, agent, 5), said(3, 5, 100), said(4, agent, 110)];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [1] }]), agent);

    expect(built.turns.map((turn) => turn.key)).toEqual([`${chat}:1`]);
  });

  test("a message the gates were asked about whose run left no scope is a turn on the record's word", () => {
    const room = [said(1, 5, 0), said(2, 5, 30), said(3, agent, 40)];
    const picks: RecordedPick[] = [{ gate: "room-rules", slug: "quiet", llm: true, attached: true }];
    const built = readTurns(reads(room, [{ run: "r1", chatId: chat, messageIds: [1, 2] }], new Map(), new Map([[`${chat}:1`, picks]])), agent);
    const record = built.turns.find((turn) => turn.source === "record")!;

    expect(record).toMatchObject({ key: `${chat}:1`, messageIds: [1], recorded: picks });
    expect([...record.attached!]).toEqual(["quiet"]);
  });

  test("a run the bot's own instructions opened is a turn named by the run, answered by what the run said", () => {
    const room = [said(1, 5, 0), said(2, agent, 5)];
    const opened = { run: "chat:-7:1:4", chatId: chat, messageIds: [], instructions: "[\uC791\uC5C5 \uC2E4\uD589 \uC0C1\uD0DC] #793 \uB05D", at: 3_000 };
    const built = readTurns(reads(room, [opened], new Map([["chat:-7:1:4", new Set(["job-793"])]]), new Map(), new Map([["chat:-7:1:4", ["", "<<SKIP>>"]]])), agent);
    const turn = built.turns.find((one) => one.source === "instructions")!;

    expect(turn).toMatchObject({ key: "chat:-7:1:4", messageIds: [], at: 3_000, reply: "<<SKIP>>", instructions: "[\uC791\uC5C5 \uC2E4\uD589 \uC0C1\uD0DC] #793 \uB05D", recorded: [] });
    expect([...turn.attached!]).toEqual(["job-793"]);
    expect(built.turns[0]).toBe(turn);
  });

  test("a run the instructions opened that said nothing is counted with no reply, and a scope of neither is no turn", () => {
    const built = readTurns(reads([], [
      { run: "silent", chatId: chat, messageIds: [], instructions: "[\uBC30\uD3EC \uC54C\uB9BC]" },
      { run: "empty", chatId: chat, messageIds: [] },
    ], new Map(), new Map(), new Map([["empty", ["\uB9D0"]]])), agent);

    expect(built.turns).toEqual([]);
    expect(built.skipped.noReply).toBe(1);
  });

  test("a turn with no reply inside the bound is left out and counted", () => {
    const built = readTurns(reads([said(1, 5, 0), said(2, agent, 5_000)], [{ run: "r", chatId: chat, messageIds: [1] }]), agent);

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
      "[\uC7A1 \uB05D\uB0A8] #12",
      "",
      "second line",
      "END OF QUIET INSTRUCTION",
      "",
      "ANSWER LANGUAGE: Korean",
    ].join("\n");

    expect(quietInstructions(prompt)).toBe("[\uC7A1 \uB05D\uB0A8] #12\n\nsecond line");
  });

  test("a prompt with no block carries no instructions", () => {
    expect(quietInstructions("TURN SCOPE: {}\nNew messages (1):\nhi\nEND OF NEW MESSAGES")).toBe("");
  });
});
