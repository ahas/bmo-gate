import { describe, expect, test } from "bun:test";

import { carriesSecret, pseudonyms, scriptOf, scrubText } from "../../training/tooling/src/pii";
import { promptText } from "../../training/tooling/src/prompts";
import { useToolingSettings } from "./settings";

useToolingSettings();

// The placeholder a kind of identifier is replaced by, as the data file words it.
function placeholder(key: string): string {
  return promptText("pii", "placeholders", key);
}

const kept = { agentId: 7_000_001, ownerId: 10_000_001 };

describe("pseudonyms", () => {
  test("keeps the chat agent's own name, because the gate's question is about it", () => {
    const names = pseudonyms("seed", kept);

    expect(names.nameOf(kept.agentId, "Robin")).toBe("Robin");
  });

  test("replaces every other name and holds to the same stand-in", () => {
    const names = pseudonyms("seed", kept);
    const first = names.nameOf(50_000_005, "Grace");

    expect(first).not.toBe("Grace");
    expect(names.nameOf(50_000_005, "Grace")).toBe(first);
  });

  test("keeps a name's script, so a Korean room still reads as one", () => {
    const names = pseudonyms("seed", kept);

    expect(scriptOf(names.nameOf(30_000_003, "\uD64D\uAE38\uB3D9"))).toBe("hangul");
    expect(scriptOf(names.nameOf(5_000_000_005, "Heidi"))).toBe("latin");
  });

  test("gives two speakers two stand-ins, so nobody is merged into somebody else", () => {
    const names = pseudonyms("seed", kept);
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map((one) => names.nameOf(one, "Heidi"));

    expect(new Set(many).size).toBe(many.length);
  });

  test("replaces the owner's number too, since the room shape already says he is the owner", () => {
    const names = pseudonyms("seed", kept);

    expect(names.idOf(kept.ownerId)).not.toBe(kept.ownerId);
    expect(names.idOf(kept.ownerId)).toBe(names.idOf(kept.ownerId));
  });

  test("leaves a message with no sender alone", () => {
    const names = pseudonyms("seed", kept);

    expect(names.idOf(null)).toBeNull();
    expect(names.nameOf(null, "\uB204\uAD6C")).toBe("\uB204\uAD6C");
  });

  test("one seed reads the same room as the same people twice", () => {
    expect(pseudonyms("one", kept).nameOf(42, "Heidi")).toBe(pseudonyms("one", kept).nameOf(42, "Heidi"));
  });
});

describe("scrubText", () => {
  test("takes out a key, which no gate has ever judged by", () => {
    const said = scrubText("the key is sk-abcdefghijklmnop1234 now");

    expect(said).toBe(`the key is ${placeholder("secret_key")} now`);
    expect(carriesSecret(said)).toBe(false);
  });

  test("takes out a mail address and a phone number", () => {
    expect(scrubText("send it to nobody@example.com")).toBe(`send it to ${placeholder("mail")}`);
    expect(scrubText("call 010-1234-5678 later")).toBe(`call ${placeholder("phone")} later`);
  });

  test("leaves a date alone, because a room is full of dates", () => {
    expect(scrubText("let's do it on 2026-09-23")).toBe("let's do it on 2026-09-23");
    expect(scrubText("came at [2026-06-19T08:12:41.000Z]")).toBe("came at [2026-06-19T08:12:41.000Z]");
  });

  test("takes out an account number, which a date's last run is too short to be", () => {
    expect(scrubText("wire it to 110-123-456789 today")).toBe(`wire it to ${placeholder("account")} today`);
  });

  test("leaves the words and the code alone, which is what the gate reads", () => {
    const said = "`bun test` \uB3CC\uB838\uB354\uB2C8 Failed to find C compiler \uAC00 \uB0AC\uC5B4";

    expect(scrubText(said)).toBe(said);
  });
});
