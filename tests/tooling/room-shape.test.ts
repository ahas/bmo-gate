import { describe, expect, test } from "bun:test";

import { inTranscriptShape } from "../../training/tooling/src/laya-synth";
import { indexOf, plainShapeLine, roomShapeLine } from "../../training/tooling/src/room-shape";
import { pseudonyms } from "../../training/tooling/src/pii";

import type { ArchivedMessage } from "../../training/tooling/src/conversation";
import { useToolingSettings } from "./settings";

useToolingSettings();

const ownerId = 10_000_001;
const agentId = 8_709_910_429;
const who = { ownerId, names: pseudonyms("test", { ownerId, agentId }) };

function said(over: Partial<ArchivedMessage> = {}): ArchivedMessage {
  return {
    chatId: -1_000, messageId: 5_510, senderId: 50_000_005, senderName: "Grace",
    sentAt: 1_780_000_000, text: "\uB2F9\uBC88 \uB204\uAD6C\uC9C0", imagePath: null, replyToMessageId: null, ...over,
  };
}

describe("roomShapeLine", () => {
  test("writes the shape a gate reading a room is handed", () => {
    const line = roomShapeLine(said(), indexOf([]), who);

    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] #5510 \S+ \(id \d+\): \uB2F9\uBC88 \uB204\uAD6C\uC9C0$/);
    expect(inTranscriptShape("room", line)).toBe(true);
  });

  test("tags the owner's line and nobody else's", () => {
    expect(roomShapeLine(said({ senderId: ownerId, senderName: "Owner" }), indexOf([]), who)).toContain(", OWNER");
    expect(roomShapeLine(said(), indexOf([]), who)).not.toContain(", OWNER");
  });

  test("writes unknown where the message carries no number", () => {
    expect(roomShapeLine(said({ senderId: null }), indexOf([]), who)).toContain("(id unknown)");
  });

  test("names what a reply answers, with the stand-in name of whoever said it", () => {
    const target = said({ messageId: 5_500, text: "\uC774\uBC88 \uC8FC \uB2F9\uBC88 \uC815\uD558\uC790" });
    const line = roomShapeLine(said({ replyToMessageId: 5_500 }), indexOf([target]), who);

    expect(line).toContain("[replies to message 5500, sent by ");
    expect(line).toContain("which said: \uC774\uBC88 \uC8FC \uB2F9\uBC88 \uC815\uD558\uC790]");
    expect(line).not.toContain("Grace");
  });

  test("says so where the archive no longer holds what a reply answers", () => {
    expect(roomShapeLine(said({ replyToMessageId: 1 }), indexOf([]), who))
      .toContain("[replies to message 1, which the archive no longer holds, so its words cannot be shown]");
  });

  test("carries no note at all where a message has nothing on it", () => {
    expect(roomShapeLine(said(), indexOf([]), who)).toEndWith(": \uB2F9\uBC88 \uB204\uAD6C\uC9C0");
  });
});

describe("plainShapeLine", () => {
  test("carries the name and the number and neither the time nor a reply marker", () => {
    const line = plainShapeLine(said({ replyToMessageId: 5_500 }), who);

    expect(line).toMatch(/^\S+ \(id \d+\): \uB2F9\uBC88 \uB204\uAD6C\uC9C0$/);
    expect(inTranscriptShape("plain", line)).toBe(true);
  });
});
