import { describe, expect, test } from "bun:test";

import { foldState, foldStateTokens } from "./fold-state";
import { layaEstimatedTokens } from "./laya";

// The same fixture stands in BMO's probe test, so the state the checkpoint is trained on and the
// state BMO asks it with are the same to the character.
const long = [
  "## 결과",
  "",
  ...Array.from({ length: 30 }, (_, i) => `- 항목 ${i + 1}: 이 줄은 목록의 한 항목을 설명하는 긴 한국어 문장이에요.`),
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "",
  "결론: 다 됐어요.",
].join("\n");

const item = (n: number) => `- 항목 ${n}: 이 줄은 목록의 한 항목을 설명하는 긴 한국어 문장이에요.`;

describe("foldState", () => {
  test("a short message stands whole in the opening, with its counts", () => {
    expect(foldState("  짧은 답이에요.\n\n둘째 줄.\n")).toEqual({
      head: "짧은 답이에요.\n\n둘째 줄.",
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
      head: ["## 결과", "", ...Array.from({ length: 10 }, (_, i) => item(i + 1))].join("\n"),
      tail: [...Array.from({ length: 5 }, (_, i) => item(i + 26)), "", "```ts", "const a = 1;", "```", "", "| a | b |", "|---|---|", "", "결론: 다 됐어요."].join("\n"),
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
    const state = foldState("가나다라마\n".repeat(4000));

    expect(layaEstimatedTokens(JSON.stringify(state))).toBeLessThanOrEqual(foldStateTokens);
    expect(state.lines).toBe(4000);
  });
});
