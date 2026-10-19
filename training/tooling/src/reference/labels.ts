import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { promptTexts } from "../prompts";

// The judgements the reference gates' data is made of, and the only part of it that is kept
// (docs/reference-data.md, 「The labels」). A label says whether one turn's answer used, or needed,
// one piece a gate could have given it.

export const referenceGates = ["system-documents", "room-rules", "library-knowledge", "people-search"] as const;

export type ReferenceGate = (typeof referenceGates)[number];

export function isReferenceGate(gate: string): gate is ReferenceGate {
  return (referenceGates as readonly string[]).includes(gate);
}

// The words a label is judged with. Their definitions are the judge's, in the room language and word for word
// as the labels were judged by, so they stand in the reference judge's data file rather than here
// (docs/reference-data.md, 「The judgement」); the file must define exactly these words, in this order.
export const attachedWordNames = ["used", "related", "unused"] as const;
export const offeredWordNames = ["needed", "not-needed"] as const;

export type AttachedWord = (typeof attachedWordNames)[number];
export type OfferedWord = (typeof offeredWordNames)[number];

function judgeWords<Word extends string>(table: string, names: readonly Word[]): Readonly<Record<Word, string>> {
  const texts = promptTexts("reference-judge", table);

  if (Object.keys(texts).join(",") !== names.join(",")) {
    throw new Error(`prompts/tooling/reference-judge.toml's ${table} words are ${Object.keys(texts).join(", ")}, not ${names.join(", ")}`);
  }

  return texts as Record<Word, string>;
}

export const attachedWords = judgeWords("attached", attachedWordNames);
export const offeredWords = judgeWords("offered", offeredWordNames);

export type UseWord = AttachedWord | OfferedWord;

export function isWordFor(attached: boolean, word: unknown): word is UseWord {
  return typeof word === "string" && Object.hasOwn(attached ? attachedWords : offeredWords, word);
}

export interface Label {
  turn: string;
  gate: ReferenceGate;
  slug: string;
  word: UseWord;
  // Whether the piece was judged as one the answer had in front of it.
  attached: boolean;
  // The judged batch it came from, `imported` for a label taken in from the first judging, or
  // `corrected` for a verdict settled outside a pass, with what settled it in `by`.
  batch: number | "imported" | "corrected";
  by?: string;
  at: string;
  // The teacher's own probability that the piece is needed, where the label was distilled with one; the
  // row's gold is then that probability rather than the word's (docs/reference-data.md, 「Distilled work
  // labels」).
  p?: number;
}

export function labelKey(turn: string, gate: string, slug: string): string {
  return `${turn}/${gate}/${slug}`;
}

// Every label standing, the latest line for a key being the one that stands.
export function readLabels(path: string): Map<string, Label> {
  const held = new Map<string, Label>();

  if (!existsSync(path)) {
    return held;
  }

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    const one = JSON.parse(line) as Label;

    held.set(labelKey(one.turn, one.gate, one.slug), one);
  }

  return held;
}

export function appendLabels(path: string, labels: readonly Label[]): void {
  if (labels.length === 0) {
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, labels.map((one) => `${JSON.stringify(one)}\n`).join(""));
}

// The labels the first judging of the chat agent's turns gave, read out of its turn file: one line a turn, each
// candidate with its gate, its slug, whether it attached and the word the judge gave it.
export function importedLabels(turnsFile: string, at: string): Label[] {
  if (!existsSync(turnsFile)) {
    return [];
  }

  const labels: Label[] = [];

  for (const line of readFileSync(turnsFile, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    const turn = JSON.parse(line) as { id: string; candidates: { gate: string; slug: string; attached: boolean; label: string | null }[] };

    for (const one of turn.candidates) {
      if (isReferenceGate(one.gate) && isWordFor(one.attached, one.label)) {
        labels.push({ turn: turn.id, gate: one.gate, slug: one.slug, word: one.label, attached: one.attached, batch: "imported", at });
      }
    }
  }

  return labels;
}

// Corrections to standing labels, one JSON object a line naming the turn, gate, slug and word, as the
// labels they append (docs/reference-data.md, 「Correcting labels」). Whether the piece was attached is
// the standing label's, and any line that cannot stand refuses the whole file.
export function correctedLabels(
  text: string,
  standing: ReadonlyMap<string, Label>,
  by: string,
  at: string,
): { labels: Label[] } | { refused: string[] } {
  const labels: Label[] = [];
  const refused: string[] = [];

  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }

    const where = `line ${index + 1}`;
    let read: { turn?: unknown; gate?: unknown; slug?: unknown; word?: unknown };

    try {
      read = JSON.parse(line) as typeof read;
    } catch {
      refused.push(`${where}: not JSON`);
      return;
    }

    const { turn, gate, slug, word } = read;

    if (typeof turn !== "string" || typeof gate !== "string" || typeof slug !== "string") {
      refused.push(`${where}: turn, gate and slug must be strings`);
      return;
    }

    if (!isReferenceGate(gate)) {
      refused.push(`${where}: ${gate} is not a reference gate`);
      return;
    }

    const held = standing.get(labelKey(turn, gate, slug));

    if (held === undefined) {
      refused.push(`${where}: ${labelKey(turn, gate, slug)} has no standing label`);
      return;
    }

    if (!isWordFor(held.attached, word)) {
      refused.push(`${where}: ${String(word)} is not a word for an ${held.attached ? "attached" : "offered"} piece`);
      return;
    }

    labels.push({ turn, gate, slug, word, attached: held.attached, batch: "corrected", by, at });
  });

  return refused.length > 0 ? { refused } : { labels };
}

// A word as gold: yes, no, or contested (null), which stands out of every comparison of sets.
export function goldYes(word: UseWord | null): boolean | null {
  if (word === "used" || word === "needed") {
    return true;
  }

  return word === "unused" || word === "not-needed" ? false : null;
}

// A label as a training gold's probability of yes: the teacher's own where it gave one, to the hundredth
// a gold is written in, and otherwise its word's.
export function labelShare(label: Pick<Label, "word" | "p">): number {
  return label.p === undefined ? goldShare(label.word) : Math.round(label.p * 100) / 100;
}

// A word as a training gold's probability of yes.
export function goldShare(word: UseWord): number {
  const yes = goldYes(word);

  return yes === null ? 0.5 : yes ? 0.95 : 0.05;
}
