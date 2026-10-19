// What the output format gate is shown of one outgoing message (docs/laya-gates.md, 「5. The output format」).
// A message worth folding is a long one, and a long one runs past what one Laya call reads, so
// the gate never reads the message whole: it reads the opening and the closing of the markdown as
// written and the counts that say how large and how built the message is. The shape is fixed to
// the character, because the gate's own fold probe builds the very same state from the same markdown and
// a checkpoint answers only the shape it was trained on; the probe's copy is held to the same fixture.

import { layaEstimatedTokens } from "./laya";

export type FoldState = {
  head: string;
  tail: string;
  chars: number;
  lines: number;
  paragraphs: number;
  items: number;
  headings: number;
  code: number;
  table: number;
};

// How much of the message the excerpts may carry, in the generous token count every fit is
// measured by. Together they leave room under the state's 768 for the counts, the field names and
// what JSON escaping adds to ordinary text; a text so full of quotes and backslashes that escaping
// doubles it has its excerpts cut shorter, a quarter at a time, until the state fits.
export const foldHeadTokens = 320;
export const foldTailTokens = 200;
export const foldStateTokens = 768;

const foldScales = [1, 0.75, 0.5, 0.25] as const;

const itemLine = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+\S/;
const headingLine = /^\s{0,3}#{1,6}\s+\S/;
const fenceLine = /^\s*(?:```|~~~)/;
const tableLine = /^\s*\|/;

function cost(char: string): number {
  return char.charCodeAt(0) < 128 ? 0.35 : 1;
}

// The longest opening of the text within the budget, ended at a line break where one falls in the
// latter half of it, so an excerpt reads as whole lines wherever it can.
function opening(text: string, budget: number): string {
  let spent = 0;
  let cut = 0;

  for (const char of text) {
    spent += cost(char);

    if (spent > budget) {
      break;
    }

    cut += char.length;
  }

  const taken = text.slice(0, cut);
  const lineEnd = taken.lastIndexOf("\n");

  return lineEnd >= taken.length / 2 ? taken.slice(0, lineEnd) : taken;
}

// The same from the other end: the longest closing within the budget, begun at a line break where
// one falls in the former half of it.
function closing(text: string, budget: number): string {
  const chars = [...text];
  let spent = 0;
  let start = chars.length;

  while (start > 0) {
    spent += cost(chars[start - 1]!);

    if (spent > budget) {
      break;
    }

    start -= 1;
  }

  const taken = chars.slice(start).join("");
  const lineStart = taken.indexOf("\n");

  return lineStart >= 0 && lineStart < taken.length / 2 ? taken.slice(lineStart + 1) : taken;
}

export function foldState(original: string): FoldState {
  const text = original.trim();
  const states = foldScales.map((scale) => () => foldStateAt(text, scale));

  for (const make of states.slice(0, -1)) {
    const state = make();

    if (layaEstimatedTokens(JSON.stringify(state)) <= foldStateTokens) {
      return state;
    }
  }

  return states.at(-1)!();
}

function foldStateAt(text: string, scale: number): FoldState {
  const headTokens = foldHeadTokens * scale;
  const tailTokens = foldTailTokens * scale;
  const all = text.split("\n");
  const filled = all.filter((line) => line.trim() !== "");
  const whole = layaEstimatedTokens(text) <= headTokens + tailTokens;
  let paragraphs = 0;
  let blank = true;

  for (const line of all) {
    const empty = line.trim() === "";

    if (!empty && blank) {
      paragraphs += 1;
    }

    blank = empty;
  }

  return {
    head: whole ? text : opening(text, headTokens),
    tail: whole ? "" : closing(text, tailTokens),
    chars: [...text].length,
    lines: filled.length,
    paragraphs,
    items: filled.filter((line) => itemLine.test(line)).length,
    headings: filled.filter((line) => headingLine.test(line)).length,
    code: Math.ceil(filled.filter((line) => fenceLine.test(line)).length / 2),
    table: filled.filter((line) => tableLine.test(line)).length,
  };
}
