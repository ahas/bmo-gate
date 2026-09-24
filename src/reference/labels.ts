import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// The judgements the reference gates' data is made of, and the only part of it that is kept
// (docs/reference-data.md, 「The labels」). A label says whether one turn's answer used, or needed,
// one piece a gate could have given it.

export const referenceGates = ["system-documents", "room-rules", "library-knowledge", "people-search"] as const;

export type ReferenceGate = (typeof referenceGates)[number];

export function isReferenceGate(gate: string): gate is ReferenceGate {
  return (referenceGates as readonly string[]).includes(gate);
}

// The judge's words for each label, which docs/reference-data.md states as the canonical text and a
// test holds this copy to.
export const attachedWords = {
  used: "답이 이 문서에만 있는 내용(사실, 수치, 이름, 절차, 규칙)을 실제로 가져다 썼다.",
  related: "답의 주제와는 맞닿아 있지만, 이 문서가 없었어도 답이 그대로였다.",
  unused: "답이 이 문서와 상관이 없다.",
} as const;

export const offeredWords = {
  needed: "답이 이 문서가 다룰 내용을 담고 있거나, 이 문서가 없어서 틀리거나 모자랐다.",
  "not-needed": "답에 이 문서가 필요하지 않았다.",
} as const;

export type AttachedWord = keyof typeof attachedWords;
export type OfferedWord = keyof typeof offeredWords;
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
  // The judged batch it came from, or `imported` for a label taken in from the first judging.
  batch: number | "imported";
  at: string;
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

// The labels the first judging of BMO's turns gave, read out of its turn file: one line a turn, each
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

// A word as gold: yes, no, or contested (null), which stands out of every comparison of sets.
export function goldYes(word: UseWord | null): boolean | null {
  if (word === "used" || word === "needed") {
    return true;
  }

  return word === "unused" || word === "not-needed" ? false : null;
}

// A word as a training gold's probability of yes.
export function goldShare(word: UseWord): number {
  const yes = goldYes(word);

  return yes === null ? 0.5 : yes ? 0.95 : 0.05;
}
