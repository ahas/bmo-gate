import { jsonArrayIn, jsonObjectsIn } from "../laya-teach";
import { filled, promptText } from "../prompts";
import { attachedWords, isWordFor, labelKey, offeredWords } from "./labels";

import type { Label, ReferenceGate, UseWord } from "./labels";
import type { LiveTurn } from "./live-inputs";
import type { ReferenceTurn, WorkWords } from "./turns";

// Whether the chat agent's answer used, or needed, each piece a turn could have carried, asked of a judge
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
  // The bot's own instructions the turn was handed, where there were any; a search's question.
  instructions?: string;
  // On a piece of work the chat agent handed out, which kind it is.
  work?: WorkWords["kind"];
  reply: string;
  pieces: JudgedPiece[];
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n${promptText("reference-judge", "batch", "clipped")}`;
}

// Which pieces a pass asks the judge about, read off the piece's gate and the label standing on it.
export type Wanting = (gate: ReferenceGate, standing: Label | undefined) => boolean;

// An ordinary pass asks about what has no label.
export const unlabelled: Wanting = (_gate, standing) => standing === undefined;

// A pass judging a word again asks about every label of that word judged before the moment, a
// corrected one excepted, and about nothing else (docs/reference-data.md, 「Judging a word again」).
// The moment is an ISO time, the shape every label's own is written in, so the two compare as text.
export function judgedAgain(word: UseWord, before: string): Wanting {
  return (_gate, standing) => standing !== undefined && standing.batch !== "corrected" && standing.word === word && standing.at < before;
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

// The item for one turn. A piece's index line and body come from what the gate's own command answered for it; an
// attached piece whose body cannot be read any more is judged by its index line alone, as an offered
// one would be.
export function judgeItem(
  turn: Pick<ReferenceTurn, "key" | "reply" | "instructions" | "work">,
  messages: string[],
  wanted: readonly { gate: ReferenceGate; slug: string; attached: boolean }[],
  live: LiveTurn,
  leave: (text: string) => string,
): JudgeItem {
  const about = (gate: ReferenceGate, slug: string): string | null =>
    live.gates.find((one) => one.gate === gate)?.candidates.find((one) => one.slug === slug)?.about
      ?? live.pieces.find((one) => one.gate === gate && one.slug === slug)?.about
      ?? null;

  // A search's question is a line of the bot's, so it stands where a turn's instructions do.
  const instructions = turn.instructions ?? (turn.work?.kind === "search" ? turn.work.query : undefined);

  return {
    id: turn.key,
    messages,
    ...instructions === undefined ? {} : { instructions: leave(instructions) },
    ...turn.work === undefined ? {} : { work: turn.work.kind },
    reply: clip(leave(turn.reply), replyLimit),
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
    ...item.instructions === undefined ? {} : { instructions: item.instructions },
    ...item.work === undefined ? {} : { work: item.work },
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

// What an item of a piece of work is, for the judge (docs/reference-data.md, 「The judgement」).
export const workLine = "An item carrying work (job or search) is no conversation turn but a piece of work the chat agent handed out: messages, or for a search instructions, are what the work was asked, and reply is the job's report or the search's document. A piece is needed where the work had to rest on what only that piece holds.";

// The judge's system prompt, its words out of `prompts/tooling/reference-judge.toml` around the judge
// words themselves.
export function judgeSystem(): string {
  const say = (key: string) => filled(promptText("reference-judge", "system", key));

  return [
    say("task"),
    say("fields"),
    say("recorded"),
    say("instructions"),
    say("skip"),
    workLine,
    "",
    say("attached"),
    ...Object.entries(attachedWords).map(([word, meaning]) => `- ${word}: ${meaning}`),
    "",
    say("offered"),
    ...Object.entries(offeredWords).map(([word, meaning]) => `- ${word}: ${meaning}`),
    "",
    say("answer"),
    say("answer_shape"),
    say("whole"),
  ].join("\n");
}

export function judgePrompt(items: readonly JudgeItem[]): string {
  return [promptText("reference-judge", "batch", "items"), ...items.map(itemText)].join("\n");
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
    // A judge may answer under the bare slug; that is read where no other piece of the item shares it.
    const shared = new Set(item.pieces.filter((piece, at) => item.pieces.findIndex((other) => other.slug === piece.slug) !== at).map((piece) => piece.slug));

    for (const piece of item.pieces) {
      const word = words[pieceKey(piece)] ?? (shared.has(piece.slug) ? undefined : words[piece.slug]);

      if (isWordFor(piece.attached, word)) {
        labels.set(labelKey(item.id, piece.gate, piece.slug), {
          turn: item.id, gate: piece.gate, slug: piece.slug, word: word as UseWord, attached: piece.attached, batch, at,
        });
      }
    }
  }

  return [...labels.values()];
}
