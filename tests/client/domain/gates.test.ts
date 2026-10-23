import { describe, expect, test } from "bun:test";

import { agreementText, byPart, gateLabel, gateLabelKey, layaLine, layaModeLabel, partLabel, refusalText } from "../../../client/app/domain/gates";

import type { Gate, LayaView } from "../../../client/shared/gate";

// Words of the test's own: they answer the keys they hold with their own name, and hold those they are given.
function pack(...held: string[]) {
  const keys = new Set(held);

  return { t: (key: string) => `<${key}>`, has: (key: string) => keys.has(key) };
}

function gate(gateName: string, part: string, step: number): Gate {
  return { gateName, part, step, condition: null, switchable: false, layaProbe: false, defaultLayaMode: null, answerTokens: null };
}

describe("what the pages call a gate", () => {
  test("is the words' name for the gate, its hyphens as underscores in the key", () => {
    const { t, has } = pack("gates.label.room_rules");

    expect(gateLabelKey("room-rules")).toBe("gates.label.room_rules");
    expect(gateLabel(t, has, "room-rules")).toBe("<gates.label.room_rules>");
  });

  test("is the gate's own name where the words have none for it", () => {
    const { t, has } = pack();

    expect(gateLabel(t, has, "no-such-gate")).toBe("no-such-gate");
  });
});

describe("the gate order", () => {
  test("is cut where the part changes, each run in the order given", () => {
    const runs = byPart([gate("a", "pre", 1), gate("b", "pre", 2), gate("c", "post", 1), gate("d", "pre", 3)]);

    expect(runs.map((run) => [run.part, run.gates.map((one) => one.gateName)])).toEqual([
      ["pre", ["a", "b"]],
      ["post", ["c"]],
      ["pre", ["d"]]
    ]);
  });

  test("words a part the words know and leaves another as it is", () => {
    const { t, has } = pack("gates.part.pre");

    expect(partLabel(t, has, "pre")).toBe("<gates.part.pre>");
    expect(partLabel(t, has, "aside")).toBe("aside");
  });
});

describe("Laya's line", () => {
  test("words a mode the words know and leaves another as it is", () => {
    const { t, has } = pack("gates.laya_mode.shadow");

    expect(layaModeLabel(t, has, "shadow")).toBe("<gates.laya_mode.shadow>");
    expect(layaModeLabel(t, has, "settle")).toBe("settle");
  });

  test("gives agreement as a whole percent, and a dash where it was never compared", () => {
    expect(agreementText(0.874)).toBe("87%");
    expect(agreementText(null)).toBe("—");
    expect(agreementText(undefined)).toBe("—");
  });

  test("is the gate's mode and agreement, and nothing for a gate Laya is not asked on", () => {
    const { t, has } = pack();
    const laya = { gates: [{ gateName: "sanitizer", mode: "shadow", agreement: { agreement: 0.5 } }] } as unknown as LayaView;

    expect(layaLine(t, has, laya, "sanitizer")).toBe("Laya shadow 50%");
    expect(layaLine(t, has, laya, "translator")).toBe("");
    expect(layaLine(t, has, null, "sanitizer")).toBe("");
  });
});

describe("a refused call", () => {
  test("is the words' sentence for the gate's code where they have one, and the caller's words otherwise", () => {
    const { t, has } = pack("gates.error.no_gate");

    expect(refusalText(t, has, { data: { code: "no-gate", error: "no such gate" } }, "fallback")).toBe("<gates.error.no_gate>");
    expect(refusalText(t, has, { data: { code: "too-large", error: "too long" } }, "fallback")).toBe("fallback");
    expect(refusalText(t, has, new Error("down"), "fallback")).toBe("fallback");
  });
});
