import { layaEstimatedTokens, layaMaxTokens, layaQuestionTokens } from "./laya";
import { mightTrigger, sanitizerGate, sanitizerQuestions } from "./laya-sanitize";
import { scrubText } from "./pii";
import { unjudgedRowOf } from "./real-rows";

import type { DowngradeNotice, SanitisedText, SpendTurn } from "./archive";
import type { SplitShares } from "./laya-dataset";
import type { UnjudgedRow } from "./real-rows";

// The sanitiser gate's second source: real material the gate already missed, gathered from the
// account safeguard's own reactions (docs/gate-data.md, 「The downgrade harvest」). A downgrade means
// the safeguard read a session's context and balked; the context it read is the sanitiser gate's
// input after the gate had already passed it, so a downgrade is an answer key for what the gate let
// through. Nothing here fixes a label by construction: a downgrade fires on the whole context, so
// which text was dangerous — and whether any was — is a judgement made on a road, and this module
// only finds the downgrades, gathers their input, and cuts it into the passages a judge is offered.
//
// Nothing here reads the archive or talks to a model: it holds what a downgrade is, how its input
// window is matched to its room, and how a window becomes the candidate passages. The archive reads
// and the road are the driver's.

// A model that answered but was never launched is a safeguard's fallback. The fallback is a Claude
// model, since the safeguard stands on the Claude account; a home model or an OpenRouter model that
// only answers is a road of its own, not a downgrade, so the family is what tells them apart.
export function fallbackModels(launched: ReadonlySet<string>, answered: readonly string[]): string[] {
  return [...new Set(answered)]
    .filter((model) => model.startsWith("claude-") && !launched.has(model))
    .sort();
}

// A downgrade the harvest found, in the room it happened in and the moment it was owed. A room is
// null where the run it was read from belongs to no room.
export interface DowngradeEvent {
  chatId: number | null;
  at: number;
  // Whether it was read from a notice the bot owed a room or from a turn a fallback answered.
  from: "notice" | "turn";
}

// One downgrade turns a session to the fallback until it is woken fresh, so many fallback-answered
// turns and the one notice the bot owed stand for a single downgrade. Marks in the same room within
// this long of each other are folded into one event, so the count is of downgrades and not of turns.
export const defaultClusterSeconds = 3_600;

export function eventKey(event: DowngradeEvent): string {
  return `${event.chatId ?? "?"}:${event.at}`;
}

// The downgrades the two traces hold, folded so each downgrade is one event. A notice is the bot's
// own record of a downgrade and is preferred as an event's mark; a fallback-answered turn with no
// notice near it is a downgrade whose notice is gone, kept as its own event.
export function downgradeEvents(
  notices: readonly DowngradeNotice[],
  turns: readonly SpendTurn[],
  clusterSeconds: number = defaultClusterSeconds,
): DowngradeEvent[] {
  const marks: DowngradeEvent[] = [
    ...notices.map((one) => ({ chatId: one.chatId, at: one.at, from: "notice" as const })),
    ...turns.map((one) => ({ chatId: one.chatId, at: one.at, from: "turn" as const })),
  ].sort((a, b) => (a.chatId ?? 0) - (b.chatId ?? 0) || a.at - b.at);

  const folded: DowngradeEvent[] = [];

  for (const mark of marks) {
    const last = folded.at(-1);
    const sameRoom = last !== undefined && last.chatId === mark.chatId;

    if (sameRoom && mark.at - last.at <= clusterSeconds) {
      // A notice is the bot's own record, so it wins the fold's mark; otherwise the earliest stands.
      if (last.from !== "notice" && mark.from === "notice") {
        last.from = "notice";
        last.at = mark.at;
      }

      continue;
    }

    folded.push({ ...mark });
  }

  return folded;
}

// How far before a downgrade its input is gathered from. The safeguard reads the session's standing
// context, so the window is the material passed through the gate in the stretch leading up to it.
export const defaultWindowSeconds = 1_800;

// The boundaries that make up a session's context — the material the safeguard reads. The bot passes
// other things through the same gate (its own outgoing messages, the board it keeps pinned), which a
// session never reads back and which are not what a downgrade fires on.
export function isContextBoundary(boundary: string): boolean {
  return boundary.startsWith("a message from ")
    || boundary.startsWith("a document a room's session reads")
    || boundary.startsWith("a reference document")
    || boundary.startsWith("the prompt of a job")
    || boundary.startsWith("a quiet instruction");
}

// Whether a passed-through text belongs to a downgrade's room. A boundary's note names the room where
// the text came from a room's own files, and then only that room's texts are kept; a note that names
// no room is kept by time alone, because concurrent sessions share the clock and the judge is what
// tells their material apart.
export function roomMatches(boundary: string, chatId: number | null): boolean {
  const named = [...boundary.matchAll(/\/(?:rooms|people)\/(-?\d+)(?:\/|\b)/g)].map((match) => Number(match[1]));

  if (named.length === 0 || chatId === null) {
    return true;
  }

  return named.includes(chatId);
}

// The texts standing in a downgrade's window that a session would have read, its room where the
// boundary names one.
export function windowTexts(
  event: DowngradeEvent,
  sanitised: readonly SanitisedText[],
  windowSeconds: number = defaultWindowSeconds,
): SanitisedText[] {
  return sanitised.filter((one) =>
    one.at <= event.at && one.at >= event.at - windowSeconds
    && isContextBoundary(one.boundary) && roomMatches(one.boundary, event.chatId));
}

// A state must fit inside one Laya call: the checkpoint reads a fixed number of tokens and keeps a
// slice of them for the question, so the state has the rest.
export const stateTokenBudget = layaMaxTokens - layaQuestionTokens;

// A long text cut into passages that each fit one Laya call, split on line breaks so a passage is a
// run of whole lines. A single line longer than the budget is cut on its own; the gate reads a text
// as it stands, and a passage that ran over would be judged on half of itself.
export function passages(text: string, budget: number = stateTokenBudget): string[] {
  const out: string[] = [];
  let held = "";

  const flush = (): void => {
    const trimmed = held.trim();

    if (trimmed !== "") {
      out.push(trimmed);
    }

    held = "";
  };

  for (const line of text.split("\n")) {
    if (layaEstimatedTokens(line) > budget) {
      flush();

      for (let at = 0; at < line.length; at += budget) {
        // A line past the budget is cut into slices of at most the budget in characters, which is
        // never more than the budget in tokens.
        out.push(line.slice(at, at + budget).trim());
      }

      continue;
    }

    if (layaEstimatedTokens(`${held}\n${line}`) > budget) {
      flush();
    }

    held = held === "" ? line : `${held}\n${line}`;
  }

  flush();

  return out.filter((one) => one !== "");
}

// A passage the judge is offered: the row it becomes, the downgrade it came from, and whether it
// carries the vocabulary of an attack. Every passage is judged, since the gate answers for far more
// than a word list names; the vocabulary only tells an over-refusal from a cause never found, and a
// clean passage worth keeping from ordinary text.
export interface Candidate {
  row: UnjudgedRow;
  eventKey: string;
  adjacent: boolean;
}

// The candidates one downgrade's window gives: every passage of every text in it, scrubbed of
// secrets and identifiers first as every real row is.
export function candidatesOf(event: DowngradeEvent, texts: readonly SanitisedText[], shares: SplitShares): Candidate[] {
  const key = eventKey(event);
  const questions = sanitizerQuestions();

  return texts.flatMap((one) => passages(scrubText(one.text)).map((passage) => ({
    row: unjudgedRowOf(sanitizerGate, passage, questions, shares),
    eventKey: key,
    adjacent: mightTrigger(passage),
  })));
}

// What one downgrade came to once its candidates were judged. Harmful where any candidate was judged
// harmful; over-refusal where none was but one carries the vocabulary of an attack — a legitimate
// request that reads like one; cause unknown where neither holds, so the causing text was never
// recovered.
export type EventOutcome = "harmful" | "over-refusal" | "unknown";

export function eventOutcome(
  candidateKeys: readonly string[],
  harmfulKeys: ReadonlySet<string>,
  adjacentKeys: ReadonlySet<string>,
): EventOutcome {
  if (candidateKeys.some((key) => harmfulKeys.has(key))) {
    return "harmful";
  }

  return candidateKeys.some((key) => adjacentKeys.has(key)) ? "over-refusal" : "unknown";
}

// What a judged passage is kept as. A harmful verdict is a DEFUSE row; a clean one is kept as CLEAN
// only where it carries the vocabulary, since ordinary text adds nothing the gate's own build lacks
// and, in a window whose cause was not found, may be the cause the judge missed.
export function keptAs(harmful: boolean, adjacent: boolean): "DEFUSE" | "CLEAN" | null {
  if (harmful) {
    return "DEFUSE";
  }

  return adjacent ? "CLEAN" : null;
}

// The harvest's own reckoning, which is the whole of what it reports: how many downgrades it found,
// and how they fell out once judged.
export interface HarvestTally {
  events: number;
  turns: number;
  harmful: number;
  overRefusal: number;
  unknown: number;
  defuseRows: number;
  cleanRows: number;
}
