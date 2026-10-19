import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "../scratch";
import { checkRepeated, gateInputs, gateVersion, readLiveTurn } from "../../../training/tooling/src/reference/live-inputs";
import { useToolingSettings } from "../settings";

useToolingSettings();

describe("readLiveTurn", () => {
  test("keeps the gates this project trains and passes over any other", () => {
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

describe("gateInputs", () => {
  // A command that answers each turn with a line of its own, as the gate's noun does, and only when it is
  // asked that noun; and that says its version.
  const where = scratchDir("bmo-reference-inputs-");
  const command = join(where, "gate-command");

  writeFileSync(command, [
    "#!/usr/bin/env bun",
    "if (process.argv[2] === '--version') { console.log('bmo-gate 0.1.0'); process.exit(0); }",
    "if (process.argv[2] !== 'reference' || process.argv[3] !== 'inputs') { console.error('no such noun'); process.exit(2); }",
    "const lines = (await Bun.stdin.text()).split('\\n').filter((line) => line.trim() !== '');",
    "if (lines.some((line) => JSON.parse(line).chatId === 0)) { console.error('no such room'); process.exit(3); }",
    "for (const line of lines) console.log(JSON.stringify({ ...JSON.parse(line), gates: [] }));",
  ].join("\n"), { mode: 0o755 });

  test("hands the turns to the gate's noun and reads a line a turn back", () => {
    expect(gateInputs([command])([{ chatId: -7, messageIds: [3] }, { chatId: -7, messageIds: [4, 5] }]).map((one) => one.messageIds))
      .toEqual([[3], [4, 5]]);
  });

  test("says what the noun said when it fails", () => {
    expect(() => gateInputs([command])([{ chatId: 0, messageIds: [1] }])).toThrow("no such room");
  });

  test("reads the gate's version off its command", () => {
    expect(gateVersion([command])).toBe("bmo-gate 0.1.0");
  });

  test("a turn asked over instructions its answer does not repeat back is missing", () => {
    const opened = { chatId: -7, messageIds: [], instructions: "[release notice]" };
    const answered = { chatId: -7, messageIds: [], missing: false, gates: [], pieces: [] };

    expect(gateInputs([command])([opened])[0]!.missing).toBe(false);
    expect(checkRepeated(opened, answered).missing).toBe(true);
    expect(checkRepeated({ chatId: -7, messageIds: [3] }, answered).missing).toBe(false);
  });

  test("a piece of work its answer does not repeat back is missing", () => {
    const work = { kind: "search", query: "release notes" } as const;
    const asked = { chatId: -7, messageIds: [], work };
    const answered = { chatId: -7, messageIds: [], missing: false, gates: [], pieces: [] };

    expect(checkRepeated(asked, answered).missing).toBe(true);
    expect(checkRepeated(asked, { ...answered, work: { kind: "search", query: "release notes" } }).missing).toBe(false);
  });

  test("asks nothing of the noun for no turns", () => {
    expect(gateInputs([join(where, "absent")])([])).toEqual([]);
  });
});
