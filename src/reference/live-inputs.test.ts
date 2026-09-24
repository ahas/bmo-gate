import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "../scratch";
import { bmoInputs, inputsScript, readLiveTurn } from "./live-inputs";

describe("readLiveTurn", () => {
  test("keeps the gates this repository trains and passes over any other", () => {
    const read = readLiveTurn(JSON.stringify({
      chatId: -7,
      messageIds: [3],
      gates: [
        { gate: "room-rules", request: { state: "s", questions: {} }, candidates: [], held: 1, capped: 0 },
        { gate: "situation-rules", request: { state: "s", questions: {} }, candidates: [], held: 1, capped: 0 },
      ],
    }));

    expect(read.gates.map((one) => one.gate)).toEqual(["room-rules"]);
    expect([read.missing, read.pieces]).toEqual([false, []]);
  });
});

describe("bmoInputs", () => {
  // A checkout whose script answers each turn with a line of its own, as BMO's does.
  const checkout = scratchDir("bmo-reference-inputs-");

  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, inputsScript), [
    "const lines = (await Bun.stdin.text()).split('\\n').filter((line) => line.trim() !== '');",
    "if (lines.some((line) => JSON.parse(line).chatId === 0)) { console.error('no such room'); process.exit(3); }",
    "for (const line of lines) console.log(JSON.stringify({ ...JSON.parse(line), gates: [] }));",
  ].join("\n"));

  test("hands the turns to BMO's script and reads a line a turn back", () => {
    expect(bmoInputs(checkout)([{ chatId: -7, messageIds: [3] }, { chatId: -7, messageIds: [4, 5] }]).map((one) => one.messageIds))
      .toEqual([[3], [4, 5]]);
  });

  test("says what the script said when it fails", () => {
    expect(() => bmoInputs(checkout)([{ chatId: 0, messageIds: [1] }])).toThrow("no such room");
  });

  test("asks nothing of the script for no turns", () => {
    expect(bmoInputs(join(checkout, "absent"))([])).toEqual([]);
  });
});
