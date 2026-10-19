import { describe, expect, test } from "bun:test";

import { agreementText, gateLabel, gateLabelKey, layaModeLabel, refusalText } from "../../../client/app/domain/gates";

// A pack of the test's own: it answers the keys it holds with their own name, and holds those it is given.
function pack(...held: string[]) {
  const keys = new Set(held);

  return { t: (key: string) => `<${key}>`, has: (key: string) => keys.has(key) };
}

describe("what the page calls a gate", () => {
  test("is the pack's word for the gate, its hyphens as underscores in the key", () => {
    const { t, has } = pack("gates.label.room_rules");

    expect(gateLabelKey("room-rules")).toBe("gates.label.room_rules");
    expect(gateLabel(t, has, "room-rules")).toBe("<gates.label.room_rules>");
  });

  test("is the gate's own name where the pack has no word for it", () => {
    const { t, has } = pack();

    expect(gateLabel(t, has, "no-such-gate")).toBe("no-such-gate");
  });
});

describe("Laya's line", () => {
  test("words a mode the pack knows and leaves another as it is", () => {
    const { t, has } = pack("gates.laya_mode.shadow");

    expect(layaModeLabel(t, has, "shadow")).toBe("<gates.laya_mode.shadow>");
    expect(layaModeLabel(t, has, "settle")).toBe("settle");
  });

  test("gives agreement as a whole percent, and a dash where it was never compared", () => {
    expect(agreementText(0.874)).toBe("87%");
    expect(agreementText(null)).toBe("—");
    expect(agreementText(undefined)).toBe("—");
  });
});

describe("a refused call", () => {
  test("is the pack's sentence for the gate's code where it has one, and the caller's words otherwise", () => {
    const { t, has } = pack("gates.error.no_gate");

    expect(refusalText(t, has, { data: { data: { code: "no_gate" } } }, "fallback")).toBe("<gates.error.no_gate>");
    expect(refusalText(t, has, { data: { data: { code: "prompt_too_long" } } }, "fallback")).toBe("fallback");
    expect(refusalText(t, has, new Error("down"), "fallback")).toBe("fallback");
  });
});
