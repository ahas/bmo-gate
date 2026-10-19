import { createHash } from "node:crypto";

import { splitOf } from "../laya-dataset";
import { layaFits, layaRequestParts } from "../laya";
import { languageOf, synthesisFor, validateSynthRow } from "../laya-synth";
import { scrubText } from "../pii";
import { labelKey, labelShare, referenceGates } from "./labels";

import type { DatasetRow, Gold, SplitShares } from "../laya-dataset";
import type { LayaQuestion, LayaRequest } from "../laya";
import type { GateSynthesis, SynthRefusal } from "../laya-synth";
import type { Pseudonyms } from "../pii";
import type { Label, ReferenceGate } from "./labels";
import type { LiveGate } from "./live-inputs";
import type { TurnSource } from "./turns";

// The reference gates' rows, made afresh on every pass out of the input the gate builds and the labels
// (docs/reference-data.md, 「What leaves the rooms」 and 「The rows」).

export const referenceShares: SplitShares = { calibration: 0.15, test: 0.15 };

// A reference row carries the turn it was made from, which is what fixes its split.
export type ReferenceRow = DatasetRow & { turn: string };

// The kind of input a turn is, as its rows name it (docs/reference-data.md, 「The rows」): a job or a
// search handed out is a work's request on one line, every other turn messages after the line they
// follow on from.
export function stratumOf(source: TurnSource): string {
  return source === "work" ? "work" : "turn";
}

// The line a message opens in the plain shape the four gates are handed: the sender's name and
// number, then the text. A message's own later lines stand without it.
const entryHead = /^(.*?) \(id (-?\d+|unknown)\): /;

// A text with every person of the room in it replaced. A sender number is replaced wherever it
// stands on its own — in a line's head, in a person-book slug, in the text — and a sender's name
// where it heads a line, which is where the input carries it as a name rather than as a word.
export function leaveRoom(text: string, names: Pseudonyms, people: ReadonlyMap<number, string>): string {
  const headed = text.split("\n").map((line) => {
    const head = entryHead.exec(line);
    const id = head === null || head[2] === "unknown" ? null : Number(head[2]);

    if (head === null || id === null || !people.has(id)) {
      return line;
    }

    return `${names.nameOf(id, head[1]!)} (id ${head[2]}): ${line.slice(head[0].length)}`;
  }).join("\n");

  return scrubText(leaveNumbers(headed, names, people));
}

// A text with every sender number in it replaced by its stand-in, and nothing else touched.
function leaveNumbers(text: string, names: Pseudonyms, people: ReadonlyMap<number, string>): string {
  return [...people.keys()]
    .filter((id) => String(Math.abs(id)).length >= 5)
    .sort((left, right) => String(right).length - String(left).length)
    .reduce((said, id) => said.replace(new RegExp(`(?<![\\d-])${id}(?!\\d)`, "g"), String(names.idOf(id))), text);
}

// A gate's input as it leaves the room: its state and every question rewritten the same way. A
// question's own name is a slug, which carries its owner's number and nothing a placeholder is for —
// an item number in it is a slug's word, not an account — so a slug has its numbers replaced and is
// otherwise kept whole, in its name and where the question's words name it.
export function leaveRequest(request: LayaRequest, names: Pseudonyms, people: ReadonlyMap<number, string>): LayaRequest {
  const slugMark = "\u0000slug\u0000";

  return {
    state: typeof request.state === "string" ? leaveRoom(request.state, names, people) : request.state,
    questions: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const renamed = leaveNumbers(id, names, people);
      const words = leaveRoom(question.instructions.replaceAll(id, slugMark), names, people).replaceAll(slugMark, renamed);

      return [renamed, { ...question, instructions: words } as LayaQuestion];
    })),
  };
}

// The newest whole messages of a state that still fit one Laya call beside its questions.
export function fittingState(request: LayaRequest): LayaRequest | null {
  if (layaFits(request)) {
    return request;
  }

  const entries: string[] = [];

  for (const line of String(request.state).split("\n")) {
    if (entryHead.test(line) || entries.length === 0) {
      entries.push(line);
    } else {
      entries[entries.length - 1] += `\n${line}`;
    }
  }

  for (let from = 1; from < entries.length; from += 1) {
    const cut = { ...request, state: entries.slice(from).join("\n") };

    if (layaFits(cut)) {
      return cut;
    }
  }

  return null;
}

function noul(yes: number): Gold {
  return { type: "noul", label: yes >= 0.5 ? "true" : "false", noul: yes, probabilities: { true: yes, false: Math.round((1 - yes) * 100) / 100 } };
}

export type RowRefusal = SynthRefusal | "too-large";

export interface GateRows {
  rows: ReferenceRow[];
  // Rows none of whose candidates has a label yet, and the candidates without one in every row.
  waiting: number;
  unlabelled: number;
  // Rows whose state was cut to its newest messages.
  cut: number;
  refused: Partial<Record<RowRefusal, number>>;
}

export function emptyGateRows(): GateRows {
  return { rows: [], waiting: 0, unlabelled: 0, cut: 0, refused: {} };
}

function specOf(gate: ReferenceGate): GateSynthesis {
  const spec = synthesisFor(gate);

  if (spec === null) {
    throw new Error(`${gate} is not a gate this tooling knows.`);
  }

  return spec;
}

// One turn's rows for one gate, one for each call the gate's client asks the turn in, or why a row is
// none. The gold is read from the labels under the turn's key and the candidate's slug as the gate named
// it, before anything is rewritten; the candidates stand in the order of the request's questions.
export function referenceTurnRows(
  turn: string,
  live: LiveGate,
  labels: ReadonlyMap<string, Label>,
  leave: (request: LayaRequest) => LayaRequest,
  into: GateRows,
  stratum: string,
): void {
  const shares = live.candidates.map((one) => {
    const label = labels.get(labelKey(turn, live.gate, one.slug));

    return label === undefined ? null : labelShare(label);
  });
  let from = 0;

  for (const part of layaRequestParts(live.request)) {
    const count = Object.keys(part.questions).length;

    partRow(turn, stratum, live.gate, part, shares.slice(from, from + count), leave, into);
    from += count;
  }
}

// The row of one call's part of a turn, its labels' shares of yes standing by place beside its questions.
function partRow(
  turn: string,
  stratum: string,
  gate: ReferenceGate,
  part: LayaRequest,
  shares: readonly (number | null)[],
  leave: (request: LayaRequest) => LayaRequest,
  into: GateRows,
): void {
  const missing = shares.filter((share) => share === null).length;

  into.unlabelled += missing;

  if (missing === shares.length) {
    into.waiting += 1;
    return;
  }

  // Laya reads each question on its own beside the state, so the labelled ones make a row without
  // the rest.
  const labelled = Object.entries(part.questions).flatMap(([id, question], at) => shares[at] === null ? [] : [[id, question] as const]);
  const judged = shares.filter((share) => share !== null);
  const left = leave({ ...part, questions: Object.fromEntries(labelled) });
  const request = fittingState(left);

  if (request === null) {
    into.refused["too-large"] = (into.refused["too-large"] ?? 0) + 1;
    return;
  }

  if (request !== left) {
    into.cut += 1;
  }

  // The questions keep the order the gate gave them, and each gold goes with its question by place, since
  // the rewriting renamed the question.
  const ids = Object.keys(request.questions);
  const gold = Object.fromEntries(ids.map((id, at) => [id, noul(judged[at]!)]));
  const spec = specOf(gate);
  const state = String(request.state);
  const verdict = validateSynthRow(spec, { state, questions: { ...request.questions }, gold }, languageOf(state));

  if (!verdict.ok) {
    into.refused[verdict.refusal] = (into.refused[verdict.refusal] ?? 0) + 1;
    return;
  }

  const hash = createHash("sha256").update(JSON.stringify({ state, questions: request.questions })).digest("hex");

  into.rows.push({
    id: `${gate}:${hash.slice(0, 16)}`,
    gate,
    split: splitOf(turn, referenceShares),
    state: JSON.stringify(state),
    questions: JSON.stringify(request.questions),
    gold: JSON.stringify(gold),
    stratum,
    turn,
  });
}

// How a gate's rows answer: questions whose gold leans yes, no, or neither, and the rows holding at
// least one yes. The yes answers are the rarer ones for every reference gate, and their count is what
// says whether the gate has anything to learn from yet.
export interface AnswerCounts {
  rows: number;
  rowsWithYes: number;
  yes: number;
  no: number;
  contested: number;
}

export function answerCounts(rows: readonly DatasetRow[]): AnswerCounts {
  const counts: AnswerCounts = { rows: rows.length, rowsWithYes: 0, yes: 0, no: 0, contested: 0 };

  for (const row of rows) {
    const golds = Object.values(JSON.parse(row.gold) as Record<string, { noul?: number }>).map((one) => one.noul ?? 0.5);

    counts.yes += golds.filter((yes) => yes > 0.5).length;
    counts.no += golds.filter((yes) => yes < 0.5).length;
    counts.contested += golds.filter((yes) => yes === 0.5).length;
    counts.rowsWithYes += golds.some((yes) => yes > 0.5) ? 1 : 0;
  }

  return counts;
}

// Every gate's rows out of every turn's inputs. Two turns whose inputs came out the same after the
// rewriting are one row, as they are one input, and the turn given first — the newest — is the one
// that stands, so one input never sits in two splits.
export function referenceRows(
  turns: readonly { key: string; source: TurnSource; gates: readonly LiveGate[] }[],
  labels: ReadonlyMap<string, Label>,
  leave: (request: LayaRequest) => LayaRequest,
): Record<ReferenceGate, GateRows> {
  const built = Object.fromEntries(referenceGates.map((gate) => [gate, emptyGateRows()])) as Record<ReferenceGate, GateRows>;

  for (const turn of turns) {
    for (const live of turn.gates) {
      referenceTurnRows(turn.key, live, labels, leave, built[live.gate], stratumOf(turn.source));
    }
  }

  for (const gate of referenceGates) {
    const seen = new Set<string>();

    built[gate].rows = built[gate].rows.filter((row) => {
      if (seen.has(row.id)) {
        return false;
      }

      seen.add(row.id);

      return true;
    });
  }

  return built;
}
