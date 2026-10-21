import { createHash } from "node:crypto";

import { foldState } from "./fold-state";
import { layaFits, layaQuestionsPerCall } from "./laya";
import { splitOf } from "./laya-dataset";
import { jsonArrayIn, jsonObjectsIn } from "./laya-teach";
import { filled, promptFile, promptText, roomName } from "./prompts";

import type { LayaQuestion, LayaRequest, LayaState } from "./laya";
import type { DatasetRow, DatasetSplit, Gold, SplitShares } from "./laya-dataset";

// The pure half of the distilled data the split gates are trained on (docs/laya-gates.md).
// Nothing here talks to a model or touches a file: it holds what each gate asks, builds the prompt
// that has a model write rows for it, reads the rows back, and refuses every row that does not
// answer the gate it was asked of.
//
// The data is invented rather than exported, so none of the export pipeline's readings of a
// recorded verdict applies to it: no row here passes through `isKorean`, which keeps only rows with
// Hangul in them and would take out the English share these gates are deliberately drawn to, and
// none passes through `datasetRows`, which averages several recorded verdicts into one gold that a
// model has already written here whole.

export type LanguageBucket = "korean" | "english" | "mixed";

export const languageBuckets = ["korean", "english", "mixed"] as const;

// The three shapes a room's messages reach a gate in. Which gate is handed which is not this
// module's choice: it is what that gate is really given.
export type TranscriptShape = "plain" | "room";

export type RoomKind = "owner" | "group" | "ai";

export const roomKinds = ["owner", "group", "ai"] as const;

// One question of a gate, as the gate always asks it. A gate that asks the same question of every
// candidate carries it once here and the candidate's own words are appended when the row is written,
// so `instructions` is what every one of that gate's questions begins with.
export interface SynthQuestion {
  // The question's name in the row. A per-candidate gate that asks one question names it after the
  // candidate alone; one that asks several names them `<slug>:<id>`.
  id: string;
  type: "noul" | "choice";
  instructions: string;
  // A choice question's options, each with what that option means.
  options?: Readonly<Record<string, string>>;
  // The answer Laya may settle on its own, where the gate is asymmetric in this question: `true` or
  // `false` for a yes/no, an option's name for a choice. Null where either answer must go to the
  // model.
  safe?: boolean | string;
}

export interface GateSynthesis {
  // The gate's name, which is what the row's `gate` column holds.
  gate: string;
  title: string;
  // Whether this gate's data is built by a generator of its own rather than by the roster driver
  // that has a model write whole rows. The sanitiser gate is: its rows are wall-to-wall attack
  // material and its label is fixed by how each row is made, so it is harvested and assembled apart
  // (docs/gate-data.md, 「The sanitiser gate's own build」). The spec still stands here for its
  // question's wording and its balance; only the roster driver leaves it out.
  builtApart?: boolean;
  // What this gate decides, in one line, as the prompt tells a model.
  judges: string;
  // Where the natural text of a state lives. Empty means the state is itself a string of text; a
  // named field may hold a string or an array of strings. A field the state carries for machinery
  // rather than for reading — the kind of room, whether a message was folded — is left out, so the
  // language a row is written in is read off what a person would read.
  textFields: readonly string[];
  // The line shape a transcript in this state takes, and the fields that hold one.
  transcript: { shape: TranscriptShape; fields: readonly string[] } | null;
  // Fields of an object state whose value is one of a fixed set rather than free text. A model
  // left to infer them from a worked example invents its own words for them — `dm` where the gate
  // says `owner` — and the field is then unusable to everything downstream.
  choices?: Readonly<Record<string, readonly string[]>>;
  // What each field of an object state holds, where the worked example alone leaves a reading open
  // that the gate never receives — a transcript that already carries the answer being judged, a
  // speaker marked as somebody they are not.
  fields?: Readonly<Record<string, string>>;
  // How long a state runs, in characters, for a gate whose real inputs run longer than a written row
  // is otherwise held to. A written row far shorter than the real ones teaches its length, so the
  // least is said as plainly as the most.
  stateChars?: { least: number; most: number };
  // The kinds of room an invented batch of this gate is set in, for a gate that stands in only some
  // of them. Every kind where it is not named.
  rooms?: readonly RoomKind[];
  // Whether the questions below are asked once of the whole state, or once of every candidate.
  perCandidate: boolean;
  questions: readonly SynthQuestion[];
  // How many candidates one row offers, for a gate that asks per candidate.
  candidates: { min: number; max: number } | null;
  // The word a reference gate's probe calls its candidates by — the word before `structure: …` — for a gate
  // whose one question is asked of each candidate beside that candidate's index line.
  candidateWord?: string;
  // The share of this gate's rows written in each language, and why, from the specification.
  language: Readonly<Record<LanguageBucket, number>>;
  // A worked row, which stands in the prompt's fixed prefix and is checked by this module's own
  // tests against the validator, so an example can never teach a shape the validator refuses.
  example: SynthRow;
}

// One row as a model writes it and as the validator reads it, before it becomes a `DatasetRow`.
export interface SynthRow {
  state: LayaState;
  questions: Record<string, LayaQuestion>;
  gold: Record<string, Gold>;
}

// What one batch asks for. Everything here varies from batch to batch and so stands behind the
// fixed prefix, where it costs a new read rather than a cached one.
export interface SynthAsk {
  gate: string;
  count: number;
  language: LanguageBucket;
  // The answer this batch is to carry, so a gate's rarer answer can be asked for outright: `true`
  // or `false` for a yes/no gate, an option's name for a choice one. Null lets the batch answer
  // however its inputs fall.
  lean: boolean | string | null;
  room: RoomKind;
  // Where a batch is for the hard cases rather than the ordinary ones.
  edge: boolean;
  // What makes this batch's inputs unlike the last one's, so a held session does not repeat itself.
  seed: string;
}

// Each answer of a question an equal share of that question's rows, which is what the specification
// fixes for every gate. The real distribution is lopsided and is left to tau rather than taught.
export function targetBalance(question: SynthQuestion): Record<string, number> {
  const answers = answersOf(question);

  return Object.fromEntries(answers.map((answer) => [answer, 1 / answers.length]));
}

export const balanceTolerance = 0.05;
export const languageTolerance = 0.05;

// What one gate's finished data owes, from the specification.
export const synthFloors = { train: 4_000, minority: 1_000, evaluation: 1_000 } as const;

// How long a written state runs, where its gate says nothing of its own.
export const defaultStateChars = 700;

export function answersOf(question: SynthQuestion): string[] {
  return question.type === "noul" ? ["true", "false"] : Object.keys(question.options ?? {});
}

// A per-candidate gate names its questions after the candidate: one question a candidate is the
// slug alone, several are the slug and the question's own name. A slug is as long as the brain's writers
// made it; what bounds a question is what one Laya call reads, and that is checked on its own.
const slugShape = /^[a-z0-9][a-z0-9-]+$/;

export function candidateOf(gate: GateSynthesis, questionId: string): { slug: string; id: string } | null {
  if (!gate.perCandidate) {
    return null;
  }

  if (gate.questions.length === 1) {
    return slugShape.test(questionId) ? { slug: questionId, id: gate.questions[0]!.id } : null;
  }

  const cut = questionId.lastIndexOf(":");

  if (cut < 0) {
    return null;
  }

  const slug = questionId.slice(0, cut);

  return slugShape.test(slug) ? { slug, id: questionId.slice(cut + 1) } : null;
}

const hangul = /[\uAC00-\uD7A3]/;
// Four words is where a fragment stops being an identifier, a path or a borrowed word and becomes
// a sentence somebody wrote in English.
const asciiWord = /[A-Za-z][A-Za-z'-]*/g;

// Which of the three languages a state is written in, by the specification's own definitions: no
// Hangul at all is English; Hangul with English prose standing beside it — two whole lines of it,
// or a quarter of the lines — is mixed; anything else is Korean, its identifiers and paths and
// borrowed words included.
export function languageOf(text: string): LanguageBucket {
  if (!hangul.test(text)) {
    return "english";
  }

  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const english = lines.filter((line) => !hangul.test(line) && (line.match(asciiWord) ?? []).length >= 4);

  return english.length >= 2 || (lines.length > 0 && english.length / lines.length >= 0.25) ? "mixed" : "korean";
}

// The text of a state as a person would read it, which is what its language is judged on. A
// transcript line's prefix — the sender's name, the number, the time — is not prose anybody wrote,
// and in a Korean room the name carries Hangul whatever language the message is in, so a line
// written in English would otherwise never read as English. What is judged is the message.
export function stateText(gate: GateSynthesis, state: LayaState): string {
  if (gate.textFields.length === 0) {
    return typeof state === "string" ? state : "";
  }

  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return "";
  }

  const held = state as Record<string, unknown>;
  const transcripts = new Set(gate.transcript?.fields ?? []);

  return gate.textFields
    .flatMap((field) => transcripts.has(field) ? lines(held[field]).map((line) => bodyOf(gate, line)) : lines(held[field]))
    .join("\n");
}

// What a transcript line says, with the prefix its shape puts in front of it taken off. A line that
// is not in the shape at all is read whole, since there is no prefix to be sure of.
function bodyOf(gate: GateSynthesis, line: string): string {
  const marker = transcriptLineShape(gate.transcript!.shape).exec(line);

  return marker === null ? line : line.slice(marker[0].length);
}

function lines(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  return Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
}

// A name is anything up to the marker, so a name carrying a colon still reads. A line opening with
// a bracket is the room shape's time and never a plain line, and without that guard the room shape
// reads as the plain one too — the name would simply swallow the time and the message number.
// A quiet instruction the bot was handed is an entry of its own, nobody's words, so it carries no
// sender and no number.
const plainLine = /^(?:(?!\[).{1,64}? \(id (?:\d{1,20}|unknown)\): |quiet instruction from the bot: )/;
// A message's own number may be negative: the receiver numbers some of what it holds from below, and
// the room shape writes the number it was given rather than one of its own.
const roomLine = /^\[[^\]]{1,40}\] #-?\d{1,20} .{1,64}? \(id (?:\d{1,20}|unknown)(?:, OWNER)?\): /;

export function transcriptLineShape(shape: TranscriptShape): RegExp {
  return shape === "plain" ? plainLine : roomLine;
}

// Whether a transcript is written in the shape its gate really receives. A transcript opens with a
// message, so the first line carrying the prefix is the whole of the test: every line after it
// either opens the next message or belongs to the message above it, and nothing about the text can
// tell those two apart. A state that is prose rather than a transcript is what this refuses, and
// prose does not open with a sender and a number.
//
// Counting the prefixed lines against the rest would be the wrong test however it were weighted:
// one message of the chat agent's is routinely a dozen lines, so a real turn of a real room has far more
// continuation lines than prefixed ones — and refusing it would refuse the very shape the gate is
// handed at every turn it runs.
export function inTranscriptShape(shape: TranscriptShape, text: string): boolean {
  const marker = transcriptLineShape(shape);
  const first = text.split("\n").find((line) => line.trim() !== "");

  return first !== undefined && marker.test(first);
}

export type SynthRefusal =
  | "empty-state"
  | "no-questions"
  | "unanswered-question"
  | "unasked-gold"
  | "wrong-question-type"
  | "wrong-instructions"
  | "bad-question-id"
  | "candidate-count"
  | "bad-answers"
  | "bad-probabilities"
  | "wrong-transcript"
  | "bad-state-field"
  | "wrong-language"
  | "too-large";

export type SynthVerdict = { ok: true } | { ok: false; refusal: SynthRefusal; detail: string };

function refuse(refusal: SynthRefusal, detail: string): SynthVerdict {
  return { ok: false, refusal, detail };
}

// Every way a row can fail its own gate, checked in one place, so a row that reaches the frozen
// file answers the question the gate really asks in the shape the gate really receives.
export function validateSynthRow(gate: GateSynthesis, row: SynthRow, wanted: LanguageBucket): SynthVerdict {
  const text = stateText(gate, row.state);

  if (text.trim() === "") {
    return refuse("empty-state", "the state carries no text");
  }

  const ids = Object.keys(row.questions);

  if (ids.length === 0) {
    return refuse("no-questions", "the row asks nothing");
  }

  const slugs = new Set<string>();

  for (const id of ids) {
    const asked = declaredFor(gate, id);

    if (asked === null) {
      return refuse("bad-question-id", `question ${id} is not a name this gate gives a question`);
    }

    if (gate.perCandidate) {
      slugs.add(candidateOf(gate, id)!.slug);
    }

    const question = row.questions[id]!;

    // A row carries whatever the model wrote, and a model that leaves a question half-written has
    // written a bad row — not an occasion for the gate to fall over. Every part is looked at
    // before it is used, so the worst a malformed row can do is be refused.
    if (!isRecord(question) || typeof question.type !== "string") {
      return refuse("wrong-question-type", `question ${id} is not a question`);
    }

    if (question.type !== asked.type) {
      return refuse("wrong-question-type", `question ${id} is a ${question.type}, and this gate asks a ${asked.type}`);
    }

    if (typeof question.instructions !== "string") {
      return refuse("wrong-instructions", `question ${id} asks nothing`);
    }

    if (!question.instructions.startsWith(asked.instructions)) {
      return refuse("wrong-instructions", `question ${id} does not ask what this gate asks`);
    }

    const gold = row.gold[id];

    if (gold === undefined) {
      return refuse("unanswered-question", `question ${id} has no gold`);
    }

    if (!isRecord(gold) || !isRecord(gold.probabilities)) {
      return refuse("bad-probabilities", `question ${id}'s gold carries no probabilities`);
    }

    const answers = answersOf(asked);
    const probabilities: Record<string, number> = gold.probabilities;
    const given = Object.keys(probabilities);

    if (given.length !== answers.length || !answers.every((answer) => given.includes(answer))) {
      return refuse("bad-answers", `question ${id} is answered with ${given.join(", ")} and asks for ${answers.join(", ")}`);
    }

    const weights = Object.values(probabilities);

    if (weights.some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 1)) {
      return refuse("bad-probabilities", `question ${id} carries a probability outside 0 to 1`);
    }

    if (Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) > 0.001) {
      return refuse("bad-probabilities", `question ${id}'s probabilities do not come to one`);
    }

    const heaviest = given.reduce((best, answer) => probabilities[answer]! > probabilities[best]! ? answer : best, given[0]!);

    if (gold.label !== heaviest) {
      return refuse("bad-probabilities", `question ${id} is labelled ${gold.label} and its likeliest answer is ${heaviest}`);
    }
  }

  for (const id of Object.keys(row.gold)) {
    if (row.questions[id] === undefined) {
      return refuse("unasked-gold", `gold ${id} answers a question the row does not ask`);
    }
  }

  if (gate.perCandidate) {
    const wantedPerSlug = gate.questions.length;

    if (ids.length !== slugs.size * wantedPerSlug) {
      return refuse("bad-question-id", `${slugs.size} candidates ask ${ids.length} questions, and this gate asks ${wantedPerSlug} of each`);
    }

    const range = gate.candidates!;

    if (slugs.size < range.min || slugs.size > range.max) {
      return refuse("candidate-count", `${slugs.size} candidates, and this gate offers ${range.min} to ${range.max}`);
    }
  }

  if (gate.transcript !== null && !transcriptsFit(gate, row.state)) {
    return refuse("wrong-transcript", `the transcript is not in this gate's ${gate.transcript.shape} shape`);
  }

  for (const [field, allowed] of Object.entries(gate.choices ?? {})) {
    const held = typeof row.state === "object" && row.state !== null && !Array.isArray(row.state)
      ? (row.state as Record<string, unknown>)[field]
      : undefined;

    if (typeof held !== "string" || !allowed.includes(held)) {
      return refuse("bad-state-field", `${field} is ${JSON.stringify(held)} and this gate says one of ${allowed.join(", ")}`);
    }
  }

  if (languageOf(text) !== wanted) {
    return refuse("wrong-language", `the row is ${languageOf(text)} and the batch asked for ${wanted}`);
  }

  if (!layaFits({ state: row.state, questions: row.questions })) {
    return refuse("too-large", "the row is past what one Laya call reads");
  }

  return { ok: true };
}

function declaredFor(gate: GateSynthesis, questionId: string): SynthQuestion | null {
  if (!gate.perCandidate) {
    return gate.questions.find((question) => question.id === questionId) ?? null;
  }

  const candidate = candidateOf(gate, questionId);

  return candidate === null ? null : gate.questions.find((question) => question.id === candidate.id) ?? null;
}

function transcriptsFit(gate: GateSynthesis, state: LayaState): boolean {
  const { shape, fields } = gate.transcript!;

  if (fields.length === 0) {
    return typeof state === "string" && inTranscriptShape(shape, state);
  }

  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return false;
  }

  const held = state as Record<string, unknown>;

  return fields.every((field) => {
    const written = lines(held[field]);

    return written.length > 0 && inTranscriptShape(shape, written.join("\n"));
  });
}

// The row as the training files hold it: the state, the questions and the gold each as a JSON
// string, and the split fixed by the input's own hash so one input never sits in two splits and
// keeps the split it had as the data grows.
export function datasetRowOf(gate: GateSynthesis, row: SynthRow, shares: SplitShares): DatasetRow {
  const request: LayaRequest = { state: row.state, questions: row.questions };
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");

  return {
    id: `${gate.gate}:${hash.slice(0, 16)}`,
    gate: gate.gate,
    split: splitOf(hash, shares),
    state: JSON.stringify(row.state),
    questions: JSON.stringify(row.questions),
    gold: JSON.stringify(row.gold),
  };
}

export function splitOfRow(gate: GateSynthesis, row: SynthRow, shares: SplitShares): DatasetSplit {
  return datasetRowOf(gate, row, shares).split;
}

// The part of the prompt that never changes while one gate is being written, so a held session
// reads it out of the cache rather than afresh every batch. Everything a batch varies stands behind
// it (`synthSuffix`). Its words stand in `prompts/tooling/laya-synth.toml`.
export function synthPrefix(gate: GateSynthesis): string {
  const say = (key: string, values: Readonly<Record<string, string | number>> = {}) => filled(promptText("laya-synth", "prompt", key), values);
  const said: string[] = [
    say("opening", { title: gate.title, gate: gate.gate }),
    say("judges", { judges: gate.judges }),
    "",
    say("row"),
    say("row_state"),
    say("row_questions"),
    say("row_gold"),
    "",
    say("untranslated"),
    say("spread"),
    "",
    say("questions"),
  ];

  for (const question of gate.questions) {
    const answers = question.type === "noul"
      ? say("noul_answers")
      : Object.entries(question.options ?? {}).map(([name, means]) => `${name} (${means})`).join(", ");

    said.push(
      gate.perCandidate
        ? say("per_candidate", { name: gate.questions.length === 1 ? say("candidate_slug") : say("slug_and_id", { id: question.id }), type: question.type })
        : say("whole_question", { id: question.id, type: question.type }),
      `${say("instructions", { instructions: question.instructions })}${gate.perCandidate ? say("instructions_candidate") : ""}`,
      say("answers", { answers }),
    );

    if (question.safe !== undefined) {
      said.push(say("asymmetric", { safe: String(question.safe) }));
    }
  }

  if (gate.perCandidate) {
    said.push("", say("candidates", { min: gate.candidates!.min, max: gate.candidates!.max }), say("slug_shape"));
  }

  if (gate.transcript !== null) {
    said.push("", say("transcript"), ...transcriptHelp(gate.transcript.shape));
  }

  const fields = Object.entries(gate.fields ?? {});

  if (fields.length > 0) {
    said.push("", say("fields"));

    for (const [field, holds] of fields) {
      said.push(`- \`${field}\`: ${holds}`);
    }
  }

  const choices = Object.entries(gate.choices ?? {});

  if (choices.length > 0) {
    said.push("", say("choices"));

    for (const [field, allowed] of choices) {
      said.push(`- \`${field}\`: ${allowed.map((one) => `\`${one}\``).join(say("choice_or"))}`);
    }
  }

  said.push(
    "",
    say("rules"),
    say("invented_people"),
    say("no_copying"),
    gate.stateChars === undefined
      ? say("one_call", { most: defaultStateChars })
      : say("one_call_range", { least: gate.stateChars.least, most: gate.stateChars.most }),
    "",
    say("example"),
    JSON.stringify(gate.example),
    "",
    say("answer_only"),
  );

  return said.join("\n");
}

function transcriptHelp(shape: TranscriptShape): string[] {
  const say = (key: string) => filled(promptText("laya-synth", "prompt.transcripts", key));
  const attachments = [say("attachments")];

  return shape === "plain"
    ? ["```", say("plain_line"), "```", say("plain_unknown"), say("plain_no_time"), ...attachments]
    : ["```", say("room_line"), "```", say("room_time"), say("room_owner"), say("room_note"), ...attachments];
}

// The part that changes every batch, which is what a held session pays a new read for.
export function synthSuffix(gate: GateSynthesis, ask: SynthAsk): string {
  const say = (key: string, values: Readonly<Record<string, string | number>> = {}) => filled(promptText("laya-synth", "prompt.batch", key), values);
  const said: string[] = [say("count", { count: ask.count })];

  said.push(say("language", { help: filled(promptText("laya-synth", "prompt.languages", ask.language)) }));
  said.push(say("room", { help: filled(promptText("laya-synth", "prompt.rooms", ask.room)) }));

  if (ask.lean !== null) {
    said.push(say("lean", { lean: String(ask.lean) }));
  }

  if (ask.edge) {
    said.push(say("edge"));
  }

  if (gate.perCandidate) {
    said.push(say("mixed_candidates"));
  }

  said.push(say("seed", { seed: ask.seed }));

  return said.join("\n");
}

export interface SynthReading {
  rows: SynthRow[];
  // What came back and could not be read as a row at all, which is not the same as a row the
  // validator refused.
  unreadable: number;
  // Whether the answer held a list of rows at all. An answer cut off mid-list — which is what a
  // batch too large for its road's answer slot comes to — holds none, and that is a lost batch
  // rather than a batch of nothing: it must be counted, or a run quietly writes no rows and calls
  // itself finished.
  readable: boolean;
  // Whether the rows had to be read out one at a time because the list around them was not whole.
  // The rows are still the rows — a broken bracket between them is the answer's punctuation and
  // not the data — but a run says when it has had to do this, and keeps the answer, because an
  // answer needing it every time is a gate whose batches want making smaller.
  salvaged: boolean;
}

// What a batch's answer comes to. A row missing any of its three parts is unreadable here; whether
// a readable row is any good is `validateSynthRow`'s to say.
export function readSynthBatch(answer: string): SynthReading {
  const whole = jsonArrayIn(answer);
  // Where the list is not whole, the rows inside it are read one at a time. What was asked for is
  // the rows, and a batch thrown away over the brackets between them is a batch bought and burnt.
  const written = whole ?? jsonObjectsIn(answer);

  if (written === null) {
    return { rows: [], unreadable: 0, readable: false, salvaged: false };
  }

  const rows: SynthRow[] = [];
  let unreadable = 0;

  for (const one of written) {
    const row = asRow(one);

    if (row === null) {
      unreadable += 1;
    } else {
      rows.push(row);
    }
  }

  return { rows, unreadable, readable: true, salvaged: whole === null };
}

function asRow(value: unknown): SynthRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const held = value as Record<string, unknown>;
  const { state, questions, gold } = held;

  if (state === undefined || !isRecord(questions) || !isRecord(gold)) {
    return null;
  }

  return { state: state as LayaState, questions: questions as Record<string, LayaQuestion>, gold: gold as Record<string, Gold> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The gates, in the specification's own order: what each is shaped like here, with its words — its
// title, what it decides, its questions' wording and its worked row — read from
// `prompts/tooling/laya-synth.toml`.
interface GateShape extends Omit<GateSynthesis, "title" | "judges" | "candidateWord" | "questions" | "example"> {
  questions: readonly Omit<SynthQuestion, "instructions" | "options">[];
  // How the worked row's state is made of what the file writes, for a gate shown a reduction of it.
  exampleState?: (written: Record<string, unknown>) => LayaState;
}

const plainPerCandidate = { textFields: [], transcript: { shape: "plain", fields: [] }, perCandidate: true } as const;

const gateShapes: readonly GateShape[] = [
  {
    gate: "system-documents",
    ...plainPerCandidate,
    candidates: { min: 1, max: layaQuestionsPerCall },
    questions: [{ id: "needed", type: "noul" }],
    language: { korean: 0.7, english: 0.1, mixed: 0.2 },
  },
  {
    gate: "room-rules",
    ...plainPerCandidate,
    candidates: { min: 1, max: layaQuestionsPerCall },
    questions: [{ id: "needed", type: "noul" }],
    language: { korean: 0.8, english: 0.05, mixed: 0.15 },
  },
  {
    gate: "library-knowledge",
    ...plainPerCandidate,
    candidates: { min: 1, max: layaQuestionsPerCall },
    questions: [{ id: "needed", type: "noul" }],
    language: { korean: 0.75, english: 0.08, mixed: 0.17 },
  },
  {
    gate: "situation-rules",
    textFields: ["situation"],
    transcript: { shape: "room", fields: ["situation"] },
    choices: { room: ["owner", "group"] },
    perCandidate: true,
    candidates: { min: 2, max: 8 },
    questions: [{ id: "applies", type: "noul" }, { id: "spent", type: "noul" }],
    language: { korean: 0.8, english: 0.05, mixed: 0.15 },
  },
  {
    gate: "knowledge-classifier",
    textFields: ["note"],
    transcript: null,
    choices: { author: ["owner", "member"] },
    perCandidate: false,
    candidates: null,
    questions: [{ id: "scope", type: "choice" }],
    language: { korean: 0.85, english: 0.05, mixed: 0.1 },
  },
  // The gate is shown a message as its opening, its closing and its counts (`fold-state.ts`), which
  // is how a message of any length fits one call; the worked row is that reduction of a short one.
  {
    gate: "output-format",
    textFields: ["head", "tail"],
    transcript: null,
    perCandidate: false,
    candidates: null,
    questions: [{ id: "fold", type: "noul" }],
    language: { korean: 0.65, english: 0.05, mixed: 0.3 },
    exampleState: (written) => foldState(String(written.message)),
  },
  {
    gate: "sanitizer",
    builtApart: true,
    textFields: [],
    transcript: null,
    perCandidate: false,
    candidates: null,
    questions: [{ id: "harmful", type: "noul", safe: false }],
    language: { korean: 0.4, english: 0.35, mixed: 0.25 },
  },
  {
    gate: "people-search",
    textFields: [],
    transcript: { shape: "plain", fields: [] },
    perCandidate: true,
    candidates: { min: 1, max: layaQuestionsPerCall },
    questions: [{ id: "needed", type: "noul" }],
    language: { korean: 0.8, english: 0.05, mixed: 0.15 },
  },
  {
    gate: "reply-wanted",
    textFields: ["recent", "message"],
    transcript: { shape: "room", fields: ["recent", "message"] },
    choices: { room: ["owner", "group"] },
    perCandidate: false,
    candidates: null,
    questions: [{ id: "forAgent", type: "noul", safe: false }],
    language: { korean: 0.8, english: 0.05, mixed: 0.15 },
  },
];

function table(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`prompts/tooling/laya-synth.toml holds no table ${where}`);
  }

  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} in prompts/tooling/laya-synth.toml is not a text`);
  }

  return filled(value);
}

// Every text of a nested value filled, so a worked row's state reads with the deployment's names.
function filledDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return filled(value);
  }

  if (Array.isArray(value)) {
    return value.map(filledDeep);
  }

  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, one]) => [key, filledDeep(one)])) : value;
}

function goldOf(written: unknown, where: string): Gold {
  const gold = table(written, where);
  const label = String(gold.label);

  if (typeof gold.noul === "number") {
    return { type: "noul", label: label === "true" ? "true" : "false", noul: gold.noul, probabilities: { true: gold.noul, false: 1 - gold.noul } };
  }

  return { type: "choice", label, probabilities: table(gold.probabilities, `${where}.probabilities`) as Record<string, number> };
}

function synthesisOf(shape: GateShape): GateSynthesis {
  const where = `gates.${shape.gate}`;
  const words = table(table(promptFile("laya-synth").gates, "gates")[shape.gate], where);
  const asked = table(words.questions, `${where}.questions`);
  const example = table(words.example, `${where}.example`);
  const { exampleState, questions, ...rest } = shape;

  return {
    ...rest,
    title: text(words.title, `${where}.title`),
    judges: text(words.judges, `${where}.judges`),
    ...(words.candidate_word === undefined ? {} : { candidateWord: text(words.candidate_word, `${where}.candidate_word`) }),
    questions: questions.map((question) => {
      const said = table(asked[question.id], `${where}.questions.${question.id}`);
      const options = said.options === undefined ? undefined : filledDeep(table(said.options, `${where}.questions.${question.id}.options`)) as Record<string, string>;

      return { ...question, instructions: text(said.instructions, `${where}.questions.${question.id}.instructions`), ...(options === undefined ? {} : { options }) };
    }),
    example: {
      state: exampleState === undefined ? filledDeep(example.state) as LayaState : exampleState(example),
      questions: Object.fromEntries(Object.entries(table(example.questions, `${where}.example.questions`)).map(([id, one]) => [
        id,
        typeof one === "string" ? ask(filled(one)) : filledDeep(one) as LayaQuestion,
      ])),
      gold: Object.fromEntries(Object.entries(table(example.gold, `${where}.example.gold`)).map(([id, one]) => [id, goldOf(one, `${where}.example.gold.${id}`)])),
    },
  };
}

function ask(instructions: string): LayaQuestion {
  return { type: "noul", instructions };
}

// The gates are built when first asked for, since their words carry the deployment's names, and built
// again only where the settings name somebody else.
let built: { names: string; gates: readonly GateSynthesis[] } | null = null;
let namesCarried: string[] | null = null;

function namesNow(): string {
  namesCarried ??= ["agent", "owner"].filter((mark) => JSON.stringify(promptFile("laya-synth")).includes(`{{${mark}}}`));

  return namesCarried.map((mark) => roomName(mark)).join("\u0000");
}

/** Every gate, in the specification's own order. */
export function gateSyntheses(): readonly GateSynthesis[] {
  const names = namesNow();

  if (built === null || built.names !== names) {
    built = { names, gates: gateShapes.map(synthesisOf) };
  }

  return built.gates;
}

export function synthesisFor(gate: string): GateSynthesis | null {
  return gateSyntheses().find((one) => one.gate === gate) ?? null;
}

// Which gates a run writes: the ones it was told to, less the ones it was told to leave out. A run
// sharing a folder with another names what it leaves out rather than what it keeps, so the roster
// stands in one place and adding a gate does not have to be remembered in a second one.
//
// A name that is no gate's is said back rather than passed over, whichever side it was given on: a
// misspelt gate left out is a gate that goes on being written, which is the very thing the run was
// told to stop doing.
export function gatesChosen(wanted: readonly string[], leftOut: readonly string[]): GateSynthesis[] | string {
  const unknown = [...wanted, ...leftOut].filter((name) => synthesisFor(name) === null);

  if (unknown.length > 0) {
    return `${unknown.join(", ")}: no such gate. Choose among: ${gateSyntheses().map((one) => one.gate).join(", ")}`;
  }

  // The default roster is the gates this driver writes, which leaves out the ones built by a
  // generator of their own; a gate built apart is written only when it is named outright, and then
  // it is turned back with where it is really built rather than written the wrong way.
  const chosen = wanted.length === 0 ? gateSyntheses().filter((one) => one.builtApart !== true) : wanted.map((name) => synthesisFor(name)!);
  const kept = chosen.filter((one) => !leftOut.includes(one.gate));
  const apart = kept.filter((one) => one.builtApart === true);

  if (apart.length > 0) {
    return `${apart.map((one) => one.gate).join(", ")}: not written by this driver; it is built by its own harvest, which this repository does not carry (docs/gate-data.md, 「The sanitiser gate's own build」).`;
  }

  if (kept.length === 0) {
    return "No gate is left. Look at --gate and --except again.";
  }

  return kept;
}
