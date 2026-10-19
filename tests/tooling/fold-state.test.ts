import { describe, expect, test } from "bun:test";

import { foldState, foldStateTokens } from "../../training/tooling/src/fold-state";
import { layaEstimatedTokens } from "../../training/tooling/src/laya";
import { useToolingSettings } from "./settings";

useToolingSettings();

// The same fixture stands in the gate's fold probe test, so the state the checkpoint is trained on and the
// state the probe asks it with are the same to the character.
const long = [
  "## \uACB0\uACFC",
  "",
  ...Array.from({ length: 30 }, (_, i) => `- \uD56D\uBAA9 ${i + 1}: \uC774 \uC904\uC740 \uBAA9\uB85D\uC758 \uD55C \uD56D\uBAA9\uC744 \uC124\uBA85\uD558\uB294 \uAE34 \uD55C\uAD6D\uC5B4 \uBB38\uC7A5\uC774\uC5D0\uC694.`),
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "",
  "\uACB0\uB860: \uB2E4 \uB410\uC5B4\uC694.",
].join("\n");

const item = (n: number) => `- \uD56D\uBAA9 ${n}: \uC774 \uC904\uC740 \uBAA9\uB85D\uC758 \uD55C \uD56D\uBAA9\uC744 \uC124\uBA85\uD558\uB294 \uAE34 \uD55C\uAD6D\uC5B4 \uBB38\uC7A5\uC774\uC5D0\uC694.`;

describe("foldState", () => {
  test("a short message stands whole in the opening, with its counts", () => {
    expect(foldState("  \uC9E7\uC740 \uB2F5\uC774\uC5D0\uC694.\n\n\uB458\uC9F8 \uC904.\n")).toEqual({
      head: "\uC9E7\uC740 \uB2F5\uC774\uC5D0\uC694.\n\n\uB458\uC9F8 \uC904.",
      tail: "",
      chars: 15,
      lines: 2,
      paragraphs: 2,
      items: 0,
      headings: 0,
      code: 0,
      table: 0,
    });
  });

  test("a long message is its opening and closing lines and the counts of the whole", () => {
    expect(foldState(long)).toEqual({
      head: ["## \uACB0\uACFC", "", ...Array.from({ length: 10 }, (_, i) => item(i + 1))].join("\n"),
      tail: [...Array.from({ length: 5 }, (_, i) => item(i + 26)), "", "```ts", "const a = 1;", "```", "", "| a | b |", "|---|---|", "", "\uACB0\uB860: \uB2E4 \uB410\uC5B4\uC694."].join("\n"),
      chars: 1314,
      lines: 37,
      paragraphs: 5,
      items: 30,
      headings: 1,
      code: 1,
      table: 2,
    });
  });

  test("a text escaping doubles still fits, its excerpts cut shorter", () => {
    const state = foldState(`${'"\\'.repeat(3000)}`);

    expect(layaEstimatedTokens(JSON.stringify(state))).toBeLessThanOrEqual(foldStateTokens);
    expect(state.head.length).toBeGreaterThan(0);
  });

  test("any length of Hangul fits", () => {
    const state = foldState("\uAC00\uB098\uB2E4\uB77C\uB9C8\n".repeat(4000));

    expect(layaEstimatedTokens(JSON.stringify(state))).toBeLessThanOrEqual(foldStateTokens);
    expect(state.lines).toBe(4000);
  });
});
