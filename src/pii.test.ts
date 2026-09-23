import { describe, expect, test } from "bun:test";

import { carriesSecret, pseudonyms, scriptOf, scrubText } from "./pii";

const kept = { bmoId: 7_000_001, ownerId: 90000001 };

describe("pseudonyms", () => {
  test("keeps BMO's own name, because the gate's question is about it", () => {
    const names = pseudonyms("seed", kept);

    expect(names.nameOf(kept.bmoId, "BMO")).toBe("BMO");
  });

  test("replaces every other name and holds to the same stand-in", () => {
    const names = pseudonyms("seed", kept);
    const first = names.nameOf(51_078_230, "Creeper");

    expect(first).not.toBe("Creeper");
    expect(names.nameOf(51_078_230, "Creeper")).toBe(first);
  });

  test("keeps a name's script, so a Korean room still reads as one", () => {
    const names = pseudonyms("seed", kept);

    expect(scriptOf(names.nameOf(29_071_912, "정수 배"))).toBe("hangul");
    expect(scriptOf(names.nameOf(5_138_538_277, "Homer"))).toBe("latin");
  });

  test("gives two speakers two stand-ins, so nobody is merged into somebody else", () => {
    const names = pseudonyms("seed", kept);
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map((one) => names.nameOf(one, "Homer"));

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
    expect(names.nameOf(null, "누구")).toBe("누구");
  });

  test("one seed reads the same room as the same people twice", () => {
    expect(pseudonyms("one", kept).nameOf(42, "Homer")).toBe(pseudonyms("one", kept).nameOf(42, "Homer"));
  });
});

describe("scrubText", () => {
  test("takes out a key, which no gate has ever judged by", () => {
    const said = scrubText("키는 sk-abcdefghijklmnop1234 이야");

    expect(said).toBe("키는 [비밀키] 이야");
    expect(carriesSecret(said)).toBe(false);
  });

  test("takes out a mail address and a phone number", () => {
    expect(scrubText("nobody@example.com 으로 보내")).toBe("[메일주소] 으로 보내");
    expect(scrubText("010-1234-5678 로 전화해")).toBe("[전화번호] 로 전화해");
  });

  test("leaves a date alone, because a room is full of dates", () => {
    expect(scrubText("2026-09-23 에 하자")).toBe("2026-09-23 에 하자");
    expect(scrubText("[2026-06-19T08:12:41.000Z] 에 왔어")).toBe("[2026-06-19T08:12:41.000Z] 에 왔어");
  });

  test("takes out an account number, which a date's last run is too short to be", () => {
    expect(scrubText("110-123-456789 로 부쳐")).toBe("[계좌번호] 로 부쳐");
  });

  test("leaves the words and the code alone, which is what the gate reads", () => {
    const said = "`bun test` 돌렸더니 Failed to find C compiler 가 났어";

    expect(scrubText(said)).toBe(said);
  });
});
