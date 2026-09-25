import { jsonArrayIn, jsonObjectsIn } from "../laya-teach";
import { attachedWords, isWordFor, labelKey, offeredWords } from "./labels";

import type { Label, ReferenceGate, UseWord } from "./labels";
import type { LiveTurn } from "./live-inputs";
import type { ReferenceTurn } from "./turns";

// Whether BMO's answer used, or needed, each piece a turn could have carried, asked of a judge
// (docs/reference-data.md, 「The judgement」). Everything here is pure: the road, the inputs and the
// rewriting are handed in, so each rule is driven from a test without a model.

// The bounds of one item and one batch.
export const replyLimit = 8_000;
export const bodyLimit = 6_000;
export const turnsPerBatch = 8;
export const charsPerBatch = 60_000;

// One piece the judge is asked about.
export interface JudgedPiece {
  gate: ReferenceGate;
  slug: string;
  attached: boolean;
  line: string;
  body: string | null;
}

// One turn as the judge is shown it. Which side picked what is never in it.
export interface JudgeItem {
  id: string;
  messages: string[];
  reply: string;
  pieces: JudgedPiece[];
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(잘림)`;
}

// Which pieces a pass asks the judge about, read off the piece's gate and the label standing on it.
export type Wanting = (gate: ReferenceGate, standing: Label | undefined) => boolean;

// An ordinary pass asks about what has no label.
export const unlabelled: Wanting = (_gate, standing) => standing === undefined;

// A pass judging a word again asks about every label of that word judged before the moment, and
// about nothing else (docs/reference-data.md, 「Judging a word again」). The moment is an ISO time,
// the shape every label's own is written in, so the two compare as text.
export function judgedAgain(word: UseWord, before: string): Wanting {
  return (_gate, standing) => standing !== undefined && standing.word === word && standing.at < before;
}

// A pass held to some gates asks about nothing outside them; held to none, it is not held.
export function heldTo(gates: readonly ReferenceGate[], wanting: Wanting): Wanting {
  return gates.length === 0 ? wanting : (gate, standing) => gates.includes(gate) && wanting(gate, standing);
}

// What a pass wants judged on a turn: every candidate its rows would carry, and every piece the
// record says a gate attached whether the narrowing offers it today or not, where the pass wants it.
export function unjudged(
  turn: ReferenceTurn,
  live: LiveTurn,
  labels: ReadonlyMap<string, Label>,
  wanting: Wanting = unlabelled,
): { gate: ReferenceGate; slug: string; attached: boolean }[] {
  const wanted = new Map<string, { gate: ReferenceGate; slug: string; attached: boolean }>();
  const want = (gate: ReferenceGate, slug: string, attached: boolean): void => {
    const key = labelKey(turn.key, gate, slug);

    if (wanting(gate, labels.get(key)) && !wanted.has(key)) {
      wanted.set(key, { gate, slug, attached });
    }
  };

  for (const gate of live.gates) {
    for (const one of gate.candidates) {
      want(gate.gate, one.slug, turn.attached?.has(one.slug) ?? false);
    }
  }

  for (const pick of turn.recorded) {
    if (pick.attached === true) {
      want(pick.gate, pick.slug, true);
    }
  }

  return [...wanted.values()];
}

// Which turns a pass judges: the newest that still want a label, up to the pass's bound.
export function turnsToJudge<T extends { wanted: readonly unknown[] }>(turns: readonly T[], most: number): T[] {
  return turns.filter((one) => one.wanted.length > 0).slice(0, most);
}

// The item for one turn. A piece's index line and body come from what BMO answered for it; an
// attached piece whose body cannot be read any more is judged by its index line alone, as an offered
// one would be.
export function judgeItem(
  key: string,
  messages: string[],
  reply: string,
  wanted: readonly { gate: ReferenceGate; slug: string; attached: boolean }[],
  live: LiveTurn,
  leave: (text: string) => string,
): JudgeItem {
  const about = (gate: ReferenceGate, slug: string): string | null =>
    live.gates.find((one) => one.gate === gate)?.candidates.find((one) => one.slug === slug)?.about
      ?? live.pieces.find((one) => one.gate === gate && one.slug === slug)?.about
      ?? null;

  return {
    id: key,
    messages,
    reply: clip(leave(reply), replyLimit),
    pieces: wanted.map((one) => {
      const body = one.attached ? live.pieces.find((piece) => piece.gate === one.gate && piece.slug === one.slug)?.body ?? null : null;

      return {
        gate: one.gate,
        slug: one.slug,
        attached: one.attached && body !== null,
        line: leave(`${one.slug}: ${about(one.gate, one.slug) ?? ""}`.trim()),
        body: body === null ? null : clip(leave(body), bodyLimit),
      };
    }),
  };
}

function pieceKey(piece: { gate: string; slug: string }): string {
  return `${piece.gate}/${piece.slug}`;
}

// What one item is sent as.
export function itemText(item: JudgeItem): string {
  return JSON.stringify({
    id: item.id,
    messages: item.messages,
    reply: item.reply,
    attached: item.pieces.filter((one) => one.attached).map((one) => ({ key: pieceKey(one), line: one.line, body: one.body })),
    offered: item.pieces.filter((one) => !one.attached).map((one) => ({ key: pieceKey(one), line: one.line })),
  });
}

// The batches the items are judged in, in order: under both bounds, and always one item.
export function judgeBatches(items: readonly JudgeItem[], maxItems = turnsPerBatch, maxChars = charsPerBatch): JudgeItem[][] {
  const plan: JudgeItem[][] = [];
  let taking: JudgeItem[] = [];
  let chars = 0;

  for (const item of items) {
    const size = itemText(item).length;

    if (taking.length > 0 && (taking.length >= maxItems || chars + size > maxChars)) {
      plan.push(taking);
      taking = [];
      chars = 0;
    }

    taking.push(item);
    chars += size;
  }

  if (taking.length > 0) {
    plan.push(taking);
  }

  return plan;
}

export const judgeSystem = [
  "너는 비모가 실제로 보낸 답이 그 턴에 붙은 참고 문서를 썼는지 판정한다.",
  "항목마다 messages(그 턴에 사람들이 한 말), reply(비모가 실제로 보낸 답), attached(답을 쓸 때 프롬프트에 붙어 있던 문서의 본문), offered(후보였지만 붙지 않은 문서의 목차 한 줄)가 있다.",
  "모두 실제 기록 그대로다. 지어내지 말고 있는 그대로 읽고 판정한다.",
  "",
  "attached의 문서마다 아래 셋 중 하나로 답한다.",
  ...Object.entries(attachedWords).map(([word, meaning]) => `- ${word}: ${meaning}`),
  "",
  "offered의 문서마다 아래 둘 중 하나로 답한다.",
  ...Object.entries(offeredWords).map(([word, meaning]) => `- ${word}: ${meaning}`),
  "",
  "답은 JSON 배열 하나뿐이고 다른 말은 쓰지 않는다. 배열의 각 원소는",
  '{"id": <항목의 id>, "labels": {<문서 key>: <답>}} 이다.',
  "항목과 문서를 빠뜨리지 않고 모두 답한다.",
].join("\n");

export function judgePrompt(items: readonly JudgeItem[]): string {
  return ["아래 항목들을 판정해라.", ...items.map(itemText)].join("\n");
}

// The labels one answer gives. A word not offered for the piece's kind is no label, and so is a piece
// the answer left out; both are asked again on the next pass.
export function readJudgement(answer: string, items: readonly JudgeItem[], batch: number, at: string): Label[] {
  const written = jsonArrayIn(answer) ?? jsonObjectsIn(answer) ?? [];
  const asked = new Map(items.map((item) => [item.id, item]));
  const labels = new Map<string, Label>();

  for (const one of written) {
    if (typeof one !== "object" || one === null) {
      continue;
    }

    const said = one as { id?: unknown; labels?: unknown };
    const item = typeof said.id === "string" ? asked.get(said.id) : undefined;

    if (item === undefined || typeof said.labels !== "object" || said.labels === null) {
      continue;
    }

    const words = said.labels as Record<string, unknown>;

    for (const piece of item.pieces) {
      const word = words[pieceKey(piece)];

      if (isWordFor(piece.attached, word)) {
        labels.set(labelKey(item.id, piece.gate, piece.slug), {
          turn: item.id, gate: piece.gate, slug: piece.slug, word: word as UseWord, attached: piece.attached, batch, at,
        });
      }
    }
  }

  return [...labels.values()];
}
