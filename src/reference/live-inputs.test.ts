import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "../scratch";
import { bmoInputs, checkInstructions, inputsScript, readLiveTurn } from "./live-inputs";

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
  // A checkout whose script answers each turn with a line of its own, as BMO's does, and only when
  // it is pointed at the pass's archive copy.
  const checkout = scratchDir("bmo-reference-inputs-");
  const copy = join(checkout, "copy", "bmo.db");

  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, inputsScript), [
    `if (process.argv[2] !== '--db' || process.argv[3] !== ${JSON.stringify(copy)}) { console.error('no archive named'); process.exit(4); }`,
    "const lines = (await Bun.stdin.text()).split('\\n').filter((line) => line.trim() !== '');",
    "if (lines.some((line) => JSON.parse(line).chatId === 0)) { console.error('no such room'); process.exit(3); }",
    "for (const line of lines) console.log(JSON.stringify({ ...JSON.parse(line), gates: [] }));",
  ].join("\n"));

  test("hands the turns to BMO's script and reads a line a turn back", () => {
    expect(bmoInputs(checkout, copy)([{ chatId: -7, messageIds: [3] }, { chatId: -7, messageIds: [4, 5] }]).map((one) => one.messageIds))
      .toEqual([[3], [4, 5]]);
  });

  test("points the script at the archive it is given and no other", () => {
    expect(() => bmoInputs(checkout, join(checkout, "live.db"))([{ chatId: -7, messageIds: [3] }])).toThrow("no archive named");
  });

  test("says what the script said when it fails", () => {
    expect(() => bmoInputs(checkout, copy)([{ chatId: 0, messageIds: [1] }])).toThrow("no such room");
  });

  test("a turn asked over instructions its answer does not repeat back is missing", () => {
    const opened = { chatId: -7, messageIds: [], instructions: "[배포 알림]" };
    const answered = { chatId: -7, messageIds: [], missing: false, gates: [], pieces: [] };

    expect(bmoInputs(checkout, copy)([opened])[0]!.missing).toBe(false);
    expect(checkInstructions(opened, answered).missing).toBe(true);
    expect(checkInstructions({ chatId: -7, messageIds: [3] }, answered).missing).toBe(false);
  });

  test("asks nothing of the script for no turns", () => {
    expect(bmoInputs(join(checkout, "absent"), copy)([])).toEqual([]);
  });
});
