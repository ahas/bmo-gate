import { createHash } from "node:crypto";

import { layaFits } from "./laya";
import { splitOf } from "./laya-dataset";
import { jsonArrayIn, jsonObjectsIn } from "./laya-teach";

import type { LayaQuestion, LayaRequest, LayaState } from "./laya";
import type { DatasetRow, DatasetSplit, Gold, SplitShares } from "./laya-dataset";

// The pure half of the distilled data the ten split gates are trained on (docs/laya-gates.md).
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
  // candidate alone; one that asks several names them `<슬러그>:<id>`.
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
  // Whether the questions below are asked once of the whole state, or once of every candidate.
  perCandidate: boolean;
  questions: readonly SynthQuestion[];
  // How many candidates one row offers, for a gate that asks per candidate.
  candidates: { min: number; max: number } | null;
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
// fixes for every gate. The real distribution is lopsided and is left to τ rather than taught.
export function targetBalance(question: SynthQuestion): Record<string, number> {
  const answers = answersOf(question);

  return Object.fromEntries(answers.map((answer) => [answer, 1 / answers.length]));
}

export const balanceTolerance = 0.05;
export const languageTolerance = 0.05;

// What one gate's finished data owes, from the specification.
export const synthFloors = { train: 4_000, minority: 1_000, evaluation: 1_000 } as const;

export function answersOf(question: SynthQuestion): string[] {
  return question.type === "noul" ? ["true", "false"] : Object.keys(question.options ?? {});
}

// A per-candidate gate names its questions after the candidate: one question a candidate is the
// slug alone, several are the slug and the question's own name.
const slugShape = /^[a-z0-9][a-z0-9-]{1,48}$/;

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

const hangul = /[가-힣]/;
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
const plainLine = /^(?!\[).{1,64}? \(id (?:\d{1,20}|unknown)\): /;
const roomLine = /^\[[^\]]{1,40}\] #\d{1,20} .{1,64}? \(id (?:\d{1,20}|unknown)(?:, OWNER)?\): /;

export function transcriptLineShape(shape: TranscriptShape): RegExp {
  return shape === "plain" ? plainLine : roomLine;
}

// Whether a transcript is written in the shape its gate really receives. A message may carry a
// newline of its own, and its later lines then stand without a prefix, so a transcript is read as
// its gate's where at least one line carries the prefix and the lines that do are not the minority.
export function inTranscriptShape(shape: TranscriptShape, text: string): boolean {
  const marker = transcriptLineShape(shape);
  const all = text.split("\n").filter((line) => line.trim() !== "");
  const marked = all.filter((line) => marker.test(line));

  return marked.length >= 1 && marked.length * 2 >= all.length;
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
// it (`synthSuffix`).
export function synthPrefix(gate: GateSynthesis): string {
  const said: string[] = [
    `너는 판정 모델 학습용 데이터를 짓는다. 이 묶음은 게이트 하나의 것이다: ${gate.title} (${gate.gate}).`,
    `이 게이트가 정하는 것: ${gate.judges}`,
    "",
    "한 행은 JSON 객체 하나이고 state, questions, gold 세 자리를 가진다.",
    "- state: 게이트가 받는 입력. 아래 모양 그대로 짓는다.",
    "- questions: 게이트가 묻는 질문들. 이름과 type과 instructions를 그대로 쓴다.",
    "- gold: 질문마다 정답을 확률 분포로 적는다. label은 확률이 가장 높은 답이고, probabilities는 그 질문이 가질 수 있는 답을 빠짐없이 그리고 그 답만 담으며 합이 1이다.",
    "",
    "questions 의 instructions 는 아래 적힌 한국어 그대로 쓴다. state 를 영어로 쓰는 묶음에서도 질문은 번역하지 않는다 — 게이트가 실제로 묻는 말이 그것 하나뿐이기 때문이다. 번역한 행은 버려진다.",
    "  확신하면 한쪽에 몰고, 사람도 갈릴 만한 자리면 갈린 만큼 나눈다. 애매한 행일수록 0.5에 가깝게 적는다.",
    "",
    "이 게이트의 질문:",
  ];

  for (const question of gate.questions) {
    const answers = question.type === "noul"
      ? "true 또는 false"
      : Object.entries(question.options ?? {}).map(([name, means]) => `${name} (${means})`).join(", ");

    said.push(
      gate.perCandidate
        ? `- 후보마다 하나씩. 이름은 ${gate.questions.length === 1 ? "후보의 슬러그" : `\`<슬러그>:${question.id}\``}, type은 ${question.type}.`
        : `- 이름 \`${question.id}\`, type ${question.type}.`,
      `  instructions는 「${question.instructions}」로 시작한다.${gate.perCandidate ? " 뒤에 그 후보가 무엇인지 붙인다." : ""}`,
      `  답: ${answers}.`,
    );

    if (question.safe !== undefined) {
      said.push(`  이 질문은 비대칭이다. 판정 모델이 혼자 낼 수 있는 답은 ${String(question.safe)} 하나뿐이므로, 그 답과 그 반대가 갈리는 경계 사례를 넉넉히 짓는다.`);
    }
  }

  if (gate.perCandidate) {
    said.push("", `후보는 한 행에 ${gate.candidates!.min}개에서 ${gate.candidates!.max}개.`, "후보의 슬러그는 소문자와 숫자와 붙임표만 쓴다.");
  }

  if (gate.transcript !== null) {
    said.push("", "대화 줄의 모양 — 이 모양을 벗어난 행은 버려진다:", ...transcriptHelp(gate.transcript.shape));
  }

  const choices = Object.entries(gate.choices ?? {});

  if (choices.length > 0) {
    said.push("", "state 의 이 자리에는 정해진 낱말만 들어간다. 다른 낱말을 지어 쓰면 그 행은 버려진다:");

    for (const [field, allowed] of choices) {
      said.push(`- \`${field}\`: ${allowed.map((one) => `\`${one}\``).join(" 또는 ")}`);
    }
  }

  said.push(
    "",
    "지켜야 할 것:",
    "- 가상 인물로 짓는다. 이름, 말투, 나이대, 호칭이 행마다 달라야 하고 같은 인물을 돌려 쓰지 않는다.",
    "- 실제 기록을 옮겨 적지 않는다. 전부 새로 짓는다.",
    "- 한 행은 판정 모델 한 번의 호출에 들어가야 한다. state는 넉넉잡아 700자를 넘기지 않는다.",
    "",
    "보기 한 행:",
    JSON.stringify(gate.example),
    "",
    "답은 JSON 배열 하나로만 낸다. 설명도 머리말도 쓰지 않는다.",
  );

  return said.join("\n");
}

function transcriptHelp(shape: TranscriptShape): string[] {
  const attachments = [
    "- 첨부는 본문 안의 자리표시자다: `[사진]`, `[음성 1:23]`, `[파일 보고서.pdf]`, `[스티커 🐤]`, `[동영상 0:47]`.",
  ];

  return shape === "plain"
    ? [
        "```",
        "<보낸 사람 이름> (id <보낸 사람 번호>): <본문>",
        "```",
        "- 번호를 모르는 사람은 `unknown`.",
        "- 이 모양에는 시각도 답장 표시도 없다. 넣지 않는다.",
        ...attachments,
      ]
    : [
        "```",
        "[<시각>] #<메시지 번호> <보낸 사람 이름> (id <보낸 사람 번호>, OWNER): <본문> <노트>",
        "```",
        "- 시각은 UTC의 ISO 8601 순간이다.",
        "- `, OWNER`는 하스가 보낸 줄에만 붙는다.",
        "- 노트는 본문 뒤에 붙는 대괄호 한 문장이고, 없으면 아무것도 붙지 않는다. 답장이면 `[replies to message 812, sent by 지우, shown elsewhere in this prompt]`처럼 적는다.",
        ...attachments,
      ];
}

// The part that changes every batch, which is what a held session pays a new read for.
export function synthSuffix(gate: GateSynthesis, ask: SynthAsk): string {
  const said: string[] = [`${ask.count}행을 지어라.`];

  said.push(`언어: ${languageHelp(ask.language)}`);
  said.push(`방: ${roomHelp(ask.room)}`);

  if (ask.lean !== null) {
    said.push(`이 묶음은 ${String(ask.lean)} 쪽 답이 나오는 입력으로 짓는다.`);
  }

  if (ask.edge) {
    said.push("이 묶음은 경계 사례다. 답이 한눈에 보이지 않고 사람도 갈릴 만한 입력으로 짓는다.");
  }

  if (gate.perCandidate) {
    said.push("후보 가운데 답이 true인 것과 false인 것이 한 행 안에 섞이게 한다.");
  }

  said.push(`앞선 묶음과 겹치지 않게 짓는다. 이 묶음의 표식: ${ask.seed}`);

  return said.join("\n");
}

function languageHelp(language: LanguageBucket): string {
  return language === "korean"
    ? "한국어로 쓴다. 영어는 낱말이나 식별자나 경로 정도로만 섞인다."
    : language === "english"
      ? "주고받는 말을 영어로만 쓴다. 보낸 사람 이름은 한국어여도 되고, 질문의 instructions 는 한국어 그대로 둔다 — 언어는 오간 말로만 따진다."
      : "한국어와 영어가 섞인다. 한 줄이 넘는 영어 덩어리 — 로그, 코드 블록, 경로 목록 — 가 한국어 글 안에 들어간다. 질문의 instructions 는 한국어 그대로 둔다.";
}

function roomHelp(room: RoomKind): string {
  return room === "owner"
    ? "하스와 비모 둘뿐인 개인방."
    : room === "group"
      ? "사람 여럿이 있는 방."
      : "다른 AI가 사람들과 함께 있는 방. 그 AI도 제 이름으로 말한다.";
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

function noul(label: "true" | "false", noulValue: number): Gold {
  return { type: "noul", label, noul: noulValue, probabilities: { true: noulValue, false: 1 - noulValue } };
}

function choice(label: string, probabilities: Record<string, number>): Gold {
  return { type: "choice", label, probabilities };
}

function ask(instructions: string): LayaQuestion {
  return { type: "noul", instructions };
}

// The ten gates, in the specification's own order.

const systemDocuments: GateSynthesis = {
  gate: "system-documents",
  title: "시스템 문서 분류기",
  judges: "이 턴에 답하려면 시스템 참고 문서 가운데 어떤 것이 필요한가",
  textFields: [],
  transcript: { shape: "plain", fields: [] },
  perCandidate: true,
  candidates: { min: 2, max: 80 },
  questions: [{ id: "needed", type: "noul", instructions: "이 대화에 답하려면 이 참고 문서가 필요한가?" }],
  language: { korean: 0.7, english: 0.1, mixed: 0.2 },
  example: {
    state: "민서 (id 4471902): 비모 워커가 잡을 어디서 받아오는지 알아?\n하스 (id 90000001): 구조 문서에 적혀 있을걸",
    questions: {
      structure: ask("이 대화에 답하려면 이 참고 문서가 필요한가? 문서 structure: 챗 프로바이더, 리시버, 에이전트, 게이트, 워커가 무엇이고 비모가 언제 깨는지"),
      wording: ask("이 대화에 답하려면 이 참고 문서가 필요한가? 문서 wording: 외래어 표기와 쓰지 않는 말"),
      "bmo-work": ask("이 대화에 답하려면 이 참고 문서가 필요한가? 문서 bmo-work: 비모가 일을 어떻게 맡고 어떻게 넘기는지"),
      "bmo-voice": ask("이 대화에 답하려면 이 참고 문서가 필요한가? 문서 bmo-voice: 비모가 말할 때의 말투와 부르는 말"),
      "bmo-history": ask("이 대화에 답하려면 이 참고 문서가 필요한가? 문서 bmo-history: 비모가 어디서 왔고 무엇을 겪었는지"),
      "relations-hass": ask("이 대화에 답하려면 이 참고 문서가 필요한가? 문서 relations-hass: 비모와 하스 사이"),
    },
    gold: {
      structure: noul("true", 0.94),
      wording: noul("false", 0.03),
      "bmo-work": noul("true", 0.71),
      "bmo-voice": noul("false", 0.06),
      "bmo-history": noul("false", 0.04),
      "relations-hass": noul("false", 0.08),
    },
  },
};

const roomRules: GateSynthesis = {
  gate: "room-rules",
  title: "방 규칙 분류기",
  judges: "이 턴에 답하려면 이 방의 규칙 가운데 어떤 것이 필요한가",
  textFields: [],
  transcript: { shape: "plain", fields: [] },
  perCandidate: true,
  candidates: { min: 1, max: 20 },
  questions: [{ id: "needed", type: "noul", instructions: "이 대화에 답하려면 이 방 규칙이 필요한가?" }],
  language: { korean: 0.8, english: 0.05, mixed: 0.15 },
  example: {
    state: "정훈 (id 8820114): 이따 회식 자리 사진 올릴게\n수아 (id 3310577): 얼굴 나온 건 빼고 올려줘",
    questions: {
      "photo-consent": ask("이 대화에 답하려면 이 방 규칙이 필요한가? 규칙 photo-consent: 얼굴이 나온 사진은 찍힌 사람이 괜찮다고 한 뒤에만 올린다"),
      "night-quiet": ask("이 대화에 답하려면 이 방 규칙이 필요한가? 규칙 night-quiet: 밤 열한 시가 넘으면 알림 가는 말을 걸지 않는다"),
      "no-links": ask("이 대화에 답하려면 이 방 규칙이 필요한가? 규칙 no-links: 낯선 주소는 그대로 붙이지 않고 무엇인지 적어 준다"),
    },
    gold: { "photo-consent": noul("true", 0.91), "night-quiet": noul("false", 0.04), "no-links": noul("false", 0.02) },
  },
};

const libraryKnowledge: GateSynthesis = {
  gate: "library-knowledge",
  title: "서고 지식 분류기",
  judges: "이 턴에 답하려면 서고의 지식 문서 가운데 어떤 것이 필요한가",
  textFields: [],
  transcript: { shape: "plain", fields: [] },
  perCandidate: true,
  candidates: { min: 1, max: 30 },
  questions: [{ id: "needed", type: "noul", instructions: "이 대화에 답하려면 이 지식 문서가 필요한가?" }],
  language: { korean: 0.75, english: 0.08, mixed: 0.17 },
  example: {
    state: "태오 (id 9912034): 배포할 때 콘솔이 500 뜨는 거 그거 왜 그런지 알아?\n태오 (id 9912034): 새로고침하면 또 멀쩡해",
    questions: {
      "deploy-console": ask("이 대화에 답하려면 이 지식 문서가 필요한가? 문서 deploy-console: 콘솔은 배포와 함께 올라가고, 서 있는 사본 위로 빌드하면 라우트 조각 이름이 바뀐다"),
      "mail-filter": ask("이 대화에 답하려면 이 지식 문서가 필요한가? 문서 mail-filter: 들어온 메일에 스팸 표시를 달아 다시 넣는 걸음"),
      "photo-repair": ask("이 대화에 답하려면 이 지식 문서가 필요한가? 문서 photo-repair: 잃어버린 사진을 다시 받아 채우는 일"),
      "room-window": ask("이 대화에 답하려면 이 지식 문서가 필요한가? 문서 room-window: 방마다 따로 서는 대화 창과 그 길이"),
      "unit-restart": ask("이 대화에 답하려면 이 지식 문서가 필요한가? 문서 unit-restart: 유닛을 다시 세우는 순서와 기다리는 곳"),
    },
    gold: {
      "deploy-console": noul("true", 0.96),
      "mail-filter": noul("false", 0.01),
      "photo-repair": noul("false", 0.02),
      "room-window": noul("false", 0.05),
      "unit-restart": noul("true", 0.58),
    },
  },
};

const situationRules: GateSynthesis = {
  gate: "situation-rules",
  title: "상황 규칙 매칭기",
  judges: "조건과 행동이 한 쌍인 규칙이 지금 상황에 맞는지, 그리고 그 규칙이 이제 다 쓰였는지",
  textFields: ["situation"],
  transcript: { shape: "room", fields: ["situation"] },
  choices: { room: ["owner", "group"] },
  perCandidate: true,
  candidates: { min: 2, max: 8 },
  questions: [
    { id: "applies", type: "noul", instructions: "이 규칙의 조건이 지금 상황에 맞는가?" },
    { id: "spent", type: "noul", instructions: "이 규칙은 이제 안 써도 되는가?" },
  ],
  language: { korean: 0.8, english: 0.05, mixed: 0.15 },
  example: {
    state: {
      room: "group",
      situation: [
        "[2026-04-11T02:14:08.000Z] #3318 연우 (id 7741208): 장 보러 나갔다 올게",
        "[2026-04-11T03:02:51.000Z] #3319 연우 (id 7741208): 다 사왔다 [사진]",
      ],
    },
    questions: {
      "grocery-ping:applies": ask("이 규칙의 조건이 지금 상황에 맞는가? 규칙 grocery-ping: 연우가 장 보러 나갔다고 하면, 돌아왔다고 할 때까지 장 본 것을 묻지 않는다"),
      "grocery-ping:spent": ask("이 규칙은 이제 안 써도 되는가? 규칙 grocery-ping: 연우가 장 보러 나갔다고 하면, 돌아왔다고 할 때까지 장 본 것을 묻지 않는다"),
      "photo-thanks:applies": ask("이 규칙의 조건이 지금 상황에 맞는가? 규칙 photo-thanks: 누가 사진을 올리면 한마디 받아 준다"),
      "photo-thanks:spent": ask("이 규칙은 이제 안 써도 되는가? 규칙 photo-thanks: 누가 사진을 올리면 한마디 받아 준다"),
    },
    gold: {
      "grocery-ping:applies": noul("false", 0.12),
      "grocery-ping:spent": noul("true", 0.88),
      "photo-thanks:applies": noul("true", 0.93),
      "photo-thanks:spent": noul("false", 0.07),
    },
  },
};

const noteScope: GateSynthesis = {
  gate: "knowledge-classifier",
  title: "메모 분류기",
  judges: "메모 하나가 적어 둔 작업 방식이 누구의 것인가",
  textFields: ["note"],
  transcript: null,
  choices: { author: ["owner", "member"] },
  perCandidate: false,
  candidates: null,
  questions: [{
    id: "scope",
    type: "choice",
    instructions: "이 메모가 기록하는 작업 방식은 누구의 것인가?",
    options: {
      universal: "모든 방의 비모가 따를 보편 규칙",
      personal: "메모를 남긴 사람 한 명의 방식",
      room: "이 방에서만 통하는 약속",
      none: "작업 방식이 아니다",
    },
  }],
  language: { korean: 0.85, english: 0.05, mixed: 0.1 },
  example: {
    state: { note: "혜린은 표를 받으면 먼저 합계 줄부터 본다. 합계가 맞아야 나머지를 읽는다.", author: "member" },
    questions: {
      scope: {
        type: "choice",
        instructions: "이 메모가 기록하는 작업 방식은 누구의 것인가?",
        criteria: {
          universal: "모든 방의 비모가 따를 보편 규칙",
          personal: "메모를 남긴 사람 한 명의 방식",
          room: "이 방에서만 통하는 약속",
          none: "작업 방식이 아니다",
        },
      },
    },
    gold: { scope: choice("personal", { universal: 0.06, personal: 0.85, room: 0.05, none: 0.04 }) },
  },
};

const outputFormat: GateSynthesis = {
  gate: "output-format",
  title: "출력 서식",
  judges: "나갈 메시지를 접을지, 그리고 변환된 글이 원문을 지켰고 접은 모양이 규칙에 맞는지",
  textFields: ["original", "candidate"],
  transcript: null,
  perCandidate: false,
  candidates: null,
  questions: [
    { id: "fold", type: "noul", instructions: "이 메시지는 채팅방에 접어서(펼치기 인용으로 감싸서) 보내야 하는가?" },
    { id: "kept", type: "noul", instructions: "변환된 글이 원문의 내용을 잃거나 바꾸지 않았는가?", safe: false },
    { id: "shape", type: "noul", instructions: "접은 모양이 규칙에 맞는가 — 대화체가 접히지 않았고 결론이 접히지 않았는가?", safe: false },
  ],
  language: { korean: 0.65, english: 0.05, mixed: 0.3 },
  example: {
    state: {
      original: "**결론: 유닛은 다시 섰어요.**\n\n로그에 `Failed to find C compiler` 가 반복되고 있었고, 헤더가 빠져 있었습니다.",
      candidate: "<b>결론: 유닛은 다시 섰어요.</b>\n\n로그에 <code>Failed to find C compiler</code> 가 반복되고 있었고, 헤더가 빠져 있었습니다.",
      folded: false,
    },
    questions: {
      fold: ask("이 메시지는 채팅방에 접어서(펼치기 인용으로 감싸서) 보내야 하는가?"),
      kept: ask("변환된 글이 원문의 내용을 잃거나 바꾸지 않았는가?"),
      shape: ask("접은 모양이 규칙에 맞는가 — 대화체가 접히지 않았고 결론이 접히지 않았는가?"),
    },
    gold: { fold: noul("false", 0.21), kept: noul("true", 0.97), shape: noul("true", 0.95) },
  },
};

const answerContent: GateSynthesis = {
  gate: "content-judge",
  title: "답변 내용 게이트",
  judges: "이 답변이 방의 흐름에 맞고 답변 내용 규칙을 지키는가",
  textFields: ["recent", "answer"],
  transcript: { shape: "room", fields: ["recent"] },
  choices: { room: ["owner", "group"] },
  perCandidate: false,
  candidates: null,
  questions: [{
    id: "keeps",
    type: "noul",
    instructions: "이 답변은 채팅방의 대화 흐름에 맞고 답변 내용 규칙(반복 없음, 받을 사람 빠짐없음, 끼어들 차례가 맞음)을 지키는가?",
    safe: true,
  }],
  language: { korean: 0.75, english: 0.05, mixed: 0.2 },
  example: {
    state: {
      room: "group",
      recent: [
        "[2026-02-03T11:40:22.000Z] #901 지훈 (id 2204815): 주말에 다들 시간 어때",
        "[2026-02-03T11:41:05.000Z] #902 나래 (id 6612390): 나는 토요일만 돼",
        "[2026-02-03T11:41:44.000Z] #903 지훈 (id 2204815): 비모야 토요일로 정리해 줘",
      ],
      answer: "토요일로 잡을게요. 나래 님이 토요일만 된다고 하셨고 지훈 님이 정리해 달라고 하셨으니, 다른 분들 안 된다는 말 없으면 그대로 둘게요.",
    },
    questions: {
      keeps: ask("이 답변은 채팅방의 대화 흐름에 맞고 답변 내용 규칙(반복 없음, 받을 사람 빠짐없음, 끼어들 차례가 맞음)을 지키는가?"),
    },
    gold: { keeps: noul("true", 0.92) },
  },
};

const sanitiser: GateSynthesis = {
  gate: "sanitizer",
  title: "무해화 게이트",
  judges: "이 글이 보안 침해 자료를 싣고 있는가",
  textFields: [],
  transcript: null,
  perCandidate: false,
  candidates: null,
  questions: [{
    id: "intrusion",
    type: "noul",
    instructions: "이 글에 실제 대상을 공격하라는 지시, 실제로 수행한 공격의 경위, 또는 보안 게이트를 우회해 공격 자료를 통과시키는 방법이 들어 있는가?",
    safe: false,
  }],
  language: { korean: 0.4, english: 0.35, mixed: 0.25 },
  example: {
    state: "라우터 설정 백업을 떠 두려고 하는데, nvram 값을 통째로 받아 두는 게 맞을까요? 되돌릴 때 뭘 조심해야 하는지 알고 싶어요.",
    questions: {
      intrusion: ask("이 글에 실제 대상을 공격하라는 지시, 실제로 수행한 공격의 경위, 또는 보안 게이트를 우회해 공격 자료를 통과시키는 방법이 들어 있는가?"),
    },
    gold: { intrusion: noul("false", 0.08) },
  },
};

const personBook: GateSynthesis = {
  gate: "people-search",
  title: "인물북 서칭",
  judges: "이 턴에 답하려면 인물 기록 가운데 어떤 것이 필요한가",
  textFields: [],
  transcript: { shape: "plain", fields: [] },
  perCandidate: true,
  candidates: { min: 2, max: 20 },
  questions: [{ id: "needed", type: "noul", instructions: "이 대화에 답하려면 이 인물 기록이 필요한가?" }],
  language: { korean: 0.8, english: 0.05, mixed: 0.15 },
  example: {
    state: "도윤 (id 5518720): 채원이 생일 선물 뭐 사지\n도윤 (id 5518720): 작년에 뭐 줬는지 기억나?",
    questions: {
      "chaewon-likes": ask("이 대화에 답하려면 이 인물 기록이 필요한가? 기록 chaewon-likes: 채원이 좋아하는 것과 싫어하는 것"),
      "chaewon-basics": ask("이 대화에 답하려면 이 인물 기록이 필요한가? 기록 chaewon-basics: 채원의 기본 사항과 부르는 말"),
      "doyun-work": ask("이 대화에 답하려면 이 인물 기록이 필요한가? 기록 doyun-work: 도윤이 하는 일과 일하는 방식"),
    },
    gold: {
      "chaewon-likes": noul("true", 0.95),
      "chaewon-basics": noul("true", 0.62),
      "doyun-work": noul("false", 0.05),
    },
  },
};

const repliesToBmo: GateSynthesis = {
  gate: "reply-wanted",
  title: "응답 여부 판정기",
  judges: "방에 들어온 이 메시지가 비모에게 한 말인가",
  textFields: ["recent", "message"],
  transcript: { shape: "room", fields: ["recent", "message"] },
  choices: { room: ["owner", "group"] },
  perCandidate: false,
  candidates: null,
  questions: [{
    id: "forBmo",
    type: "noul",
    instructions: "이 메시지는 비모에게 한 말인가?",
    safe: false,
  }],
  language: { korean: 0.8, english: 0.05, mixed: 0.15 },
  example: {
    state: {
      room: "group",
      recent: [
        "[2026-06-19T08:12:41.000Z] #5510 세영 (id 3391044): 비모야 이번 주 당번 누구지",
        "[2026-06-19T08:12:58.000Z] #5511 비모 (id 7000001): 이번 주는 준호 님이에요.",
      ],
      message: "[2026-06-19T08:13:20.000Z] #5512 세영 (id 3391044): 아 맞다 고마워",
    },
    questions: { forBmo: ask("이 메시지는 비모에게 한 말인가?") },
    gold: { forBmo: noul("true", 0.83) },
  },
};

export const gateSyntheses: readonly GateSynthesis[] = [
  systemDocuments,
  roomRules,
  libraryKnowledge,
  situationRules,
  noteScope,
  outputFormat,
  answerContent,
  sanitiser,
  personBook,
  repliesToBmo,
];

export function synthesisFor(gate: string): GateSynthesis | null {
  return gateSyntheses.find((one) => one.gate === gate) ?? null;
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
    return `${unknown.join(", ")} 은 게이트 이름이 아닙니다. 이 중에서 고르세요: ${gateSyntheses.map((one) => one.gate).join(", ")}`;
  }

  const chosen = wanted.length === 0 ? [...gateSyntheses] : wanted.map((name) => synthesisFor(name)!);
  const kept = chosen.filter((one) => !leftOut.includes(one.gate));

  if (kept.length === 0) {
    return "남는 게이트가 없습니다. --gate 와 --except 를 다시 보세요.";
  }

  return kept;
}
