import { describe, expect, test } from "bun:test";

import {
  candidatesOf, downgradeEvents, eventKey, eventOutcome, fallbackModels, isContextBoundary,
  passages, roomMatches, windowTexts,
} from "./laya-downgrade";
import { sanitizerGate } from "./laya-sanitize";

import type { DowngradeEvent } from "./laya-downgrade";
import type { DowngradeNotice, SanitisedText, SpendTurn } from "./archive";

const shares = { calibration: 0.15, test: 0.15 };

describe("fallbackModels", () => {
  test("a Claude model that answers but was never launched is a fallback", () => {
    const launched = new Set(["claude-opus-5-5", "claude-haiku-4-5", "qwen3.8-27b"]);
    const answered = ["claude-opus-5-5", "claude-opus-4-8", "gpt-5.6-sol", "qwen3.8-27b"];

    expect(fallbackModels(launched, answered)).toEqual(["claude-opus-4-8"]);
  });

  test("a launched model, and a non-Claude road, are not fallbacks", () => {
    const launched = new Set(["claude-opus-5-5"]);

    expect(fallbackModels(launched, ["claude-opus-5-5", "gpt-6-astra"])).toEqual([]);
  });
});

describe("downgradeEvents", () => {
  const notice = (chatId: number, at: number): DowngradeNotice => ({ chatId, at });
  const turn = (chatId: number, at: number): SpendTurn => ({ run: `chat:${chatId}:${at}`, model: "claude-opus-4-8", chatId, at });

  test("marks in one room within the cluster fold into one event", () => {
    const events = downgradeEvents([notice(5, 1_000)], [turn(5, 1_050), turn(5, 1_200)], 3_600);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ chatId: 5, from: "notice" });
  });

  test("a notice wins the fold's mark over a turn that came first", () => {
    const events = downgradeEvents([notice(5, 1_100)], [turn(5, 1_000)], 3_600);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ chatId: 5, at: 1_100, from: "notice" });
  });

  test("marks past the cluster, or in another room, are separate events", () => {
    const events = downgradeEvents([notice(5, 1_000), notice(5, 10_000), notice(6, 1_000)], [], 3_600);

    expect(events).toHaveLength(3);
  });

  test("a fallback turn with no notice near it stands as its own event", () => {
    const events = downgradeEvents([], [turn(7, 2_000)], 3_600);

    expect(events).toEqual([{ chatId: 7, at: 2_000, from: "turn" }]);
  });
});

describe("isContextBoundary", () => {
  test("the boundaries a session reads are context", () => {
    expect(isContextBoundary("a message from Kim in a chat room")).toBe(true);
    expect(isContextBoundary("a document a room's session reads (/x/rooms/5/people/index.md)")).toBe(true);
    expect(isContextBoundary("the prompt of a job about to be run by a code-editing agent")).toBe(true);
  });

  test("what the bot sends out, and its pinned board, are not context", () => {
    expect(isContextBoundary("a message BMO is about to send to a chat room")).toBe(false);
    expect(isContextBoundary("the board BMO keeps pinned in the owner's chat listing the jobs running now")).toBe(false);
  });
});

describe("roomMatches", () => {
  test("a boundary that names a room keeps only that room", () => {
    const boundary = "a document a room's session reads (/x/rooms/5/people/index.md)";

    expect(roomMatches(boundary, 5)).toBe(true);
    expect(roomMatches(boundary, 6)).toBe(false);
  });

  test("a boundary that names no room, or a null room, is kept", () => {
    expect(roomMatches("a message from Kim in a chat room", 5)).toBe(true);
    expect(roomMatches("a document a room's session reads (/x/rooms/5/index.md)", null)).toBe(true);
  });
});

describe("windowTexts", () => {
  const event: DowngradeEvent = { chatId: 5, at: 2_000, from: "notice" };
  const text = (boundary: string, at: number): SanitisedText => ({ text: "x", changed: false, boundary, at });

  test("keeps context in the window and this room, drops the rest", () => {
    const kept = windowTexts(event, [
      text("a message from Kim in a chat room", 1_900),
      text("a message from Kim in a chat room", 100),
      text("a message BMO is about to send to a chat room", 1_950),
      text("a document a room's session reads (/x/rooms/6/index.md)", 1_950),
      text("a document a room's session reads (/x/rooms/5/index.md)", 1_950),
    ], 1_800);

    expect(kept).toHaveLength(2);
  });
});

describe("passages", () => {
  test("a short text is one passage", () => {
    expect(passages("a short line", 100)).toEqual(["a short line"]);
  });

  test("a text over the budget splits on line breaks and every passage fits", () => {
    const text = Array.from({ length: 20 }, (_, at) => `line number ${at}`).join("\n");
    const out = passages(text, 10);

    expect(out.length).toBeGreaterThan(1);
    expect(out.join(" ")).toContain("line number 0");
    expect(out.join(" ")).toContain("line number 19");
  });

  test("empty text gives no passages", () => {
    expect(passages("   \n  \n", 100)).toEqual([]);
  });
});

describe("candidatesOf", () => {
  const event: DowngradeEvent = { chatId: 5, at: 2_000, from: "notice" };
  const text = (body: string): SanitisedText => ({ text: body, changed: false, boundary: "a message from Kim in a chat room", at: 1_900 });

  test("only attack-adjacent passages become candidate sanitiser rows", () => {
    const candidates = candidatesOf(event, [text("an ordinary line about lunch\nan exploit against the host")], shares);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.row.gate).toBe(sanitizerGate);
    expect(candidates[0]!.eventKey).toBe(eventKey(event));
  });

  test("a window with no attack vocabulary gives no candidates", () => {
    expect(candidatesOf(event, [text("lunch plans and the weather")], shares)).toEqual([]);
  });
});

describe("eventOutcome", () => {
  test("harmful where a candidate is judged harmful", () => {
    expect(eventOutcome(["a", "b"], new Set(["b"]))).toBe("harmful");
  });

  test("over-refusal where there are candidates but none are harmful", () => {
    expect(eventOutcome(["a", "b"], new Set(["c"]))).toBe("over-refusal");
  });

  test("cause unknown where no attack-adjacent passage was found", () => {
    expect(eventOutcome([], new Set(["a"]))).toBe("unknown");
  });
});
