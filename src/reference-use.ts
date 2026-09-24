import { createHash } from "node:crypto";

import { candidateOf, datasetRowOf, languageOf, stateText, synthesisFor, validateSynthRow } from "./laya-synth";
import { jsonArrayIn, jsonObjectsIn } from "./laya-teach";
import { scrubText } from "./pii";
import { offeredSets, turnEndingAt } from "./real-rows";
import { plainShapeLine } from "./room-shape";

import type { ArchivedMessage } from "./archive";
import type { DatasetRow, Gold, SplitShares } from "./laya-dataset";
import type { LayaQuestion, LayaRequest } from "./laya";
import type { GateSynthesis, SynthRefusal } from "./laya-synth";
import type { FrozenRow } from "./laya-synth-run";
import type { ShapeWho } from "./room-shape";

// Whether the answer BMO sent used the pieces a reference gate attached (docs/reference-use.md).
// Everything here is pure: the archive, the bodies, the judge and the Laya server are handed in by
// the script, so each rule below is driven from a test without a database or a model.

export const useGates = ["system-documents", "room-rules", "library-knowledge", "people-search"] as const;

export type UseGate = (typeof useGates)[number];

export function isUseGate(gate: string): gate is UseGate {
  return (useGates as readonly string[]).includes(gate);
}

// The judge's words for each label, which docs/reference-use.md states as the canonical text and a
// test holds this copy to.
export const attachedLabels = {
  used: "답이 이 문서에만 있는 내용(사실, 수치, 이름, 절차, 규칙)을 실제로 가져다 썼다.",
  related: "답의 주제와는 맞닿아 있지만, 이 문서가 없었어도 답이 그대로였다.",
  unused: "답이 이 문서와 상관이 없다.",
} as const;

export const offeredLabels = {
  needed: "답이 이 문서가 다룰 내용을 담고 있거나, 이 문서가 없어서 틀리거나 모자랐다.",
  "not-needed": "답에 이 문서가 필요하지 않았다.",
} as const;

export type AttachedLabel = keyof typeof attachedLabels;
export type OfferedLabel = keyof typeof offeredLabels;
export type UseLabel = AttachedLabel | OfferedLabel;

// The bounds of one item and one batch.
export const replyLimit = 8_000;
export const bodyLimit = 6_000;
export const turnsPerBatch = 8;
export const charsPerBatch = 60_000;
export const replyBoundSeconds = 1_800;
export const turnGapSeconds = 600;

// Where a turn was read from: BMO's per-candidate reference record, or the agent log's runs of the
// classifier the four gates replaced.
export type TurnSource = "record" | "log";

// One row of BMO's per-candidate reference record, as this measure reads it.
export interface RecordedCandidate {
  source: TurnSource;
  stage: string;
  chatId: number;
  messageId: number;
  slug: string;
  llm: boolean;
  // Null where the record did not say, which a yes left that way means the turn predates it.
  attached: boolean | null;
}

// One probe input the Laya record kept for a turn and a gate.
export interface RecordedProbe {
  stage: string;
  chatId: number;
  messageId: number;
  request: LayaRequest;
}

export interface FragmentRead {
  line: string;
  body: string | null;
}

export interface UseCandidate {
  gate: UseGate;
  slug: string;
  line: string;
  llm: boolean;
  attached: boolean;
  body: string | null;
  bodyHash: string | null;
  label: UseLabel | null;
}

export interface UseTurn {
  id: string;
  source: TurnSource;
  chatId: number;
  messageId: number;
  // The turn's own messages as the judge reads them, and as a training row's state is built.
  lines: string[];
  reply: string;
  candidates: UseCandidate[];
  // Every probe input the turn kept for a gate: one, or one for each call a gate too large for a
  // single call was split into.
  probes: Partial<Record<UseGate, LayaRequest[]>>;
}

export interface UseReads {
  candidates(): RecordedCandidate[];
  probes(): RecordedProbe[];
  room(chatId: number): ArchivedMessage[];
  fragment(chatId: number, slug: string): FragmentRead | null;
}

export interface TurnBuild {
  turns: UseTurn[];
  // Turns left out, by why.
  skipped: { noMessage: number; noReply: number; noAttachment: number };
}

export function candidateKey(gate: string, slug: string): string {
  return `${gate}/${slug}`;
}

function turnKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

// The reply to the message at `at`: the first run of BMO's own messages after it, inside the bound,
// up to the next message somebody else sends.
export function replyAfter(room: readonly ArchivedMessage[], at: number, bmoId: number, boundSeconds = replyBoundSeconds): string | null {
  const asked = room[at]!;
  let start = -1;

  for (let next = at + 1; next < room.length; next += 1) {
    const one = room[next]!;

    if (one.sentAt - asked.sentAt > boundSeconds) {
      break;
    }

    if (one.senderId === bmoId) {
      start = next;
      break;
    }
  }

  if (start < 0) {
    return null;
  }

  const said: string[] = [];

  for (let next = start; next < room.length && room[next]!.senderId === bmoId; next += 1) {
    if (room[next]!.text.trim() !== "") {
      said.push(room[next]!.text);
    }
  }

  return said.length === 0 ? null : said.join("\n\n");
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(잘림)`;
}

// The slug each probe question names, for the gate that asked it.
function probeSlugs(spec: GateSynthesis, request: LayaRequest): string[] {
  return Object.keys(request.questions)
    .map((id) => candidateOf(spec, id)?.slug ?? null)
    .filter((slug): slug is string => slug !== null);
}

function specOf(gate: string): GateSynthesis {
  const spec = synthesisFor(gate);

  if (spec === null) {
    throw new Error(`${gate} 는 이 저장소가 아는 게이트가 아닙니다.`);
  }

  return spec;
}

// Every turn the reference record holds, with its reply, its candidates across the four gates and
// the bodies of what attached. A candidate the probe asked about and the record has no row for — a
// person-book piece its LLM passed over — joins the turn as offered and not picked.
export function useTurns(reads: UseReads, who: ShapeWho & { bmoId: number }): TurnBuild {
  const byTurn = new Map<string, RecordedCandidate[]>();

  for (const one of reads.candidates()) {
    if (!isUseGate(one.stage)) {
      continue;
    }

    const key = turnKey(one.chatId, one.messageId);

    byTurn.set(key, [...(byTurn.get(key) ?? []), one]);
  }

  const probes = new Map<string, Partial<Record<UseGate, LayaRequest[]>>>();

  for (const one of reads.probes()) {
    if (!isUseGate(one.stage)) {
      continue;
    }

    const key = turnKey(one.chatId, one.messageId);
    const held = probes.get(key) ?? {};
    const asked = held[one.stage] ?? [];
    const questions = JSON.stringify(Object.keys(one.request.questions));

    // The same input recorded twice is one call, not two.
    if (!asked.some((request) => JSON.stringify(Object.keys(request.questions)) === questions)) {
      probes.set(key, { ...held, [one.stage]: [...asked, one.request] });
    }
  }

  const rooms = new Map<number, ArchivedMessage[]>();
  const turns: UseTurn[] = [];
  const skipped = { noMessage: 0, noReply: 0, noAttachment: 0 };

  for (const [key, recorded] of byTurn) {
    const { chatId, messageId } = recorded[0]!;

    // A yes the record never said attached or not cannot be told apart from one the safety line
    // dropped, and the two are judged by different questions.
    if (recorded.some((one) => one.llm && one.attached === null)) {
      skipped.noAttachment += 1;
      continue;
    }

    const room = rooms.get(chatId) ?? reads.room(chatId);

    rooms.set(chatId, room);

    const at = room.findIndex((one) => one.messageId === messageId);

    if (at < 0) {
      skipped.noMessage += 1;
      continue;
    }

    const reply = replyAfter(room, at, who.bmoId);

    if (reply === null) {
      skipped.noReply += 1;
      continue;
    }

    const turnProbes = probes.get(key) ?? {};
    const seen = new Set<string>();
    const candidates: UseCandidate[] = [];
    const add = (gate: UseGate, slug: string, llm: boolean, attached: boolean): void => {
      const name = candidateKey(gate, slug);

      if (seen.has(name)) {
        return;
      }

      seen.add(name);

      const read = reads.fragment(chatId, slug);
      const body = attached && read?.body != null ? scrubText(read.body) : null;

      candidates.push({
        gate, slug, llm, attached,
        line: scrubText(read?.line ?? slug),
        body,
        bodyHash: body === null ? null : createHash("sha256").update(body).digest("hex").slice(0, 16),
        label: null,
      });
    };

    for (const one of recorded) {
      add(one.stage as UseGate, one.slug, one.llm, one.attached === true);
    }

    for (const gate of useGates) {
      for (const request of turnProbes[gate] ?? []) {
        for (const slug of probeSlugs(specOf(gate), request)) {
          add(gate, slug, false, false);
        }
      }
    }

    turns.push({
      id: key,
      source: recorded[0]!.source,
      chatId,
      messageId,
      lines: turnEndingAt(room, at, who.bmoId, turnGapSeconds).map((one) => plainShapeLine(one, who)),
      reply: scrubText(reply),
      candidates,
      probes: turnProbes,
    });
  }

  return { turns, skipped };
}

// The piece one context line of BMO's turn run names: a path whose last part is the piece's slug, or
// a root document's file name, which is its slug in upper case.
export function contextSlug(text: string): string {
  return (text.split("/").at(-1) ?? text).replace(/\.md$/i, "").toLowerCase();
}

// The headings the classifier's prompt put each library under, and the gate that library is now.
// They are words the log wrote rather than a choice made here, so they are matched as written.
const classifierHeadings: readonly (readonly [string, UseGate])[] = [
  ["# System reference index", "system-documents"],
  ["# Room rules", "room-rules"],
  ["# Knowledge index", "library-knowledge"],
];

// An index line in the shape every library writes one, and a slug as an answer names it.
const indexLine = /^- ([a-z0-9-]+)(?:\s+(\[[^\]]*\]))?\s+—\s+(.+)$/;
const slugWord = /^[a-z0-9][a-z0-9-]*$/;

// One run of the classifier the four gates replaced, as the agent log kept it.
export interface LoggedClassifierRun {
  chatId: number;
  messageId: number;
  prompt: string;
  // Whether the log kept the prompt whole rather than cutting it short.
  whole: boolean;
  answer: string;
}

// Why a logged run is no turn: its prompt was cut, its answer was a failure rather than a choice, or
// no turn run of BMO says what reached the prompt.
export type LogSkip = "cut" | "failed" | "noContext";

export interface LoggedTurn {
  candidates: RecordedCandidate[];
  probes: RecordedProbe[];
}

// A probe's question about one candidate, in the words BMO's reference probe puts it in: the gate's
// own question, the word the gate calls a candidate by, the slug and what its index line says.
export function probeQuestion(gate: UseGate, slug: string, about: string): LayaQuestion {
  const spec = specOf(gate);

  return { type: "noul", instructions: `${spec.questions[0]!.instructions} ${spec.candidateWord ?? ""} ${slug}: ${about}` };
}

// A classifier run as the record would have kept it: every candidate under the gate its heading
// names, the classifier's pick as the LLM's yes, what the turn run's context lines name as attached,
// and a probe rebuilt for each gate that was offered something.
export function classifierTurn(run: LoggedClassifierRun, attached: ReadonlySet<string> | null): LoggedTurn | LogSkip {
  const parts = run.whole ? /^INDEX:\n([\s\S]*)\n\nMESSAGES:\n([\s\S]*)$/.exec(run.prompt) : null;

  if (parts === null) {
    return "cut";
  }

  const offered = new Map<UseGate, { slug: string; about: string }[]>();
  let gate: UseGate | null = null;

  for (const line of parts[1]!.split("\n")) {
    if (line.startsWith("# ")) {
      gate = classifierHeadings.find(([heading]) => line.startsWith(heading))?.[1] ?? null;
      continue;
    }

    const entry = indexLine.exec(line.trim());
    const held = gate === null ? [] : offered.get(gate) ?? [];

    if (gate !== null && entry !== null && !held.some((one) => one.slug === entry[1])) {
      offered.set(gate, [...held, { slug: entry[1]!, about: entry[3]! }]);
    }
  }

  const said = run.answer.trim();
  const picked = said === "none" ? [] : said.split(/[\n,]/).map((one) => one.trim()).filter((one) => one !== "");
  const slugs = new Set([...offered.values()].flat().map((one) => one.slug));

  if (said === "" || !picked.every((slug) => slugWord.test(slug) && slugs.has(slug))) {
    return "failed";
  }

  if (attached === null) {
    return "noContext";
  }

  const chosen = new Set(picked);
  const where = { chatId: run.chatId, messageId: run.messageId };

  return {
    candidates: [...offered].flatMap(([stage, entries]) => entries.map((one) => ({
      source: "log" as const, stage, ...where, slug: one.slug, llm: chosen.has(one.slug), attached: attached.has(one.slug),
    }))),
    probes: [...offered].map(([stage, entries]) => ({
      stage,
      ...where,
      request: {
        state: parts[2]!,
        questions: Object.fromEntries(entries.map((one) => [one.slug, probeQuestion(stage, one.slug, one.about)])),
      },
    })),
  };
}

// What one turn is shown as. Which side picked what is never in it.
export function useItem(turn: UseTurn): Record<string, unknown> {
  return {
    id: turn.id,
    messages: turn.lines,
    reply: clip(turn.reply, replyLimit),
    attached: turn.candidates.filter((one) => one.attached).map((one) => ({
      key: candidateKey(one.gate, one.slug), line: one.line, body: clip(one.body ?? "(본문을 읽지 못함)", bodyLimit),
    })),
    offered: turn.candidates.filter((one) => !one.attached).map((one) => ({ key: candidateKey(one.gate, one.slug), line: one.line })),
  };
}

// The batches the turns are judged in, in order: under both bounds, and always one turn.
export function useBatches(turns: readonly UseTurn[], maxTurns = turnsPerBatch, maxChars = charsPerBatch): UseTurn[][] {
  const plan: UseTurn[][] = [];
  let taking: UseTurn[] = [];
  let chars = 0;

  for (const turn of turns) {
    const size = JSON.stringify(useItem(turn)).length;

    if (taking.length > 0 && (taking.length >= maxTurns || chars + size > maxChars)) {
      plan.push(taking);
      taking = [];
      chars = 0;
    }

    taking.push(turn);
    chars += size;
  }

  if (taking.length > 0) {
    plan.push(taking);
  }

  return plan;
}

export const useSystem = [
  "너는 비모가 실제로 보낸 답이 그 턴에 붙은 참고 문서를 썼는지 판정한다.",
  "항목마다 messages(그 턴에 사람들이 한 말), reply(비모가 실제로 보낸 답), attached(답을 쓸 때 프롬프트에 붙어 있던 문서의 본문), offered(후보였지만 붙지 않은 문서의 목차 한 줄)가 있다.",
  "모두 실제 기록 그대로다. 지어내지 말고 있는 그대로 읽고 판정한다.",
  "",
  "attached의 문서마다 아래 셋 중 하나로 답한다.",
  ...Object.entries(attachedLabels).map(([label, meaning]) => `- ${label}: ${meaning}`),
  "",
  "offered의 문서마다 아래 둘 중 하나로 답한다.",
  ...Object.entries(offeredLabels).map(([label, meaning]) => `- ${label}: ${meaning}`),
  "",
  "답은 JSON 배열 하나뿐이고 다른 말은 쓰지 않는다. 배열의 각 원소는",
  '{"id": <항목의 id>, "labels": {<문서 key>: <답>}} 이다.',
  "항목과 문서를 빠뜨리지 않고 모두 답한다.",
].join("\n");

export function usePrompt(turns: readonly UseTurn[]): string {
  return ["아래 항목들을 판정해라.", ...turns.map((turn) => JSON.stringify(useItem(turn)))].join("\n");
}

// The labels one answer gives, per turn and candidate. A word not offered for the candidate's kind
// is no label, and so is a candidate the answer left out.
export function readUseAnswer(answer: string, turns: readonly UseTurn[]): Map<string, Map<string, UseLabel>> {
  const written = jsonArrayIn(answer) ?? jsonObjectsIn(answer) ?? [];
  const asked = new Map(turns.map((turn) => [turn.id, turn]));
  const read = new Map<string, Map<string, UseLabel>>();

  for (const one of written) {
    if (typeof one !== "object" || one === null) {
      continue;
    }

    const said = one as { id?: unknown; labels?: unknown };
    const turn = typeof said.id === "string" ? asked.get(said.id) : undefined;

    if (turn === undefined || typeof said.labels !== "object" || said.labels === null) {
      continue;
    }

    const labels = said.labels as Record<string, unknown>;
    const kept = new Map<string, UseLabel>();

    for (const candidate of turn.candidates) {
      const name = candidateKey(candidate.gate, candidate.slug);
      const label = labels[name];
      const allowed = candidate.attached ? attachedLabels : offeredLabels;

      if (typeof label === "string" && Object.hasOwn(allowed, label)) {
        kept.set(name, label as UseLabel);
      }
    }

    read.set(turn.id, kept);
  }

  return read;
}

export function labelTurns(turns: readonly UseTurn[], labels: ReadonlyMap<string, ReadonlyMap<string, UseLabel>>): void {
  for (const turn of turns) {
    const kept = labels.get(turn.id);

    for (const candidate of turn.candidates) {
      candidate.label = kept?.get(candidateKey(candidate.gate, candidate.slug)) ?? null;
    }
  }
}

// A label as gold: yes, no, or contested (null), which stands out of every comparison of sets.
export function goldYes(label: UseLabel | null): boolean | null {
  if (label === "used" || label === "needed") {
    return true;
  }

  return label === "unused" || label === "not-needed" ? false : null;
}

// A label as a training gold's probability of yes.
export function goldShare(label: UseLabel): number {
  const yes = goldYes(label);

  return yes === null ? 0.5 : yes ? 0.95 : 0.05;
}

// Laya's fresh answer for one turn and gate, per candidate slug: its probability of yes.
export type LayaAnswers = Record<string, number>;

export function layaAnswersOf(gate: UseGate, reply: unknown): LayaAnswers | null {
  const answers = typeof reply === "object" && reply !== null ? (reply as { answers?: unknown }).answers : null;

  if (typeof answers !== "object" || answers === null) {
    return null;
  }

  const spec = specOf(gate);
  const read: LayaAnswers = {};

  for (const [id, answer] of Object.entries(answers as Record<string, unknown>)) {
    const slug = candidateOf(spec, id)?.slug;
    const noul = (answer as { noul?: unknown } | null)?.noul;

    if (slug !== undefined && typeof noul === "number") {
      read[slug] = noul;
    }
  }

  return read;
}

export const taus = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99] as const;

export interface TauFigures {
  tau: number;
  settled: number;
  share: number;
  matchGold: number;
  accuracyGold: number | null;
  matchLlm: number;
  accuracyLlm: number | null;
}

export interface GateFigures {
  gate: UseGate;
  turns: number;
  attached: number;
  used: number;
  related: number;
  unused: number;
  unlabelledAttached: number;
  overSelection: number | null;
  offered: number;
  needed: number;
  missTurns: number;
  // The LLM gate's own set against the use gold, over the turns Laya was also asked on and over all.
  llmAccuracyGold: number | null;
  llmMatchGold: number;
  llmComparable: number;
  laya: { turns: number; byTau: TauFigures[] } | null;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;
}

// Whether a set of yeses matches the gold on the uncontested, labelled candidates.
function matches(turnCandidates: readonly UseCandidate[], says: (slug: string) => boolean | null): boolean | null {
  let compared = 0;

  for (const candidate of turnCandidates) {
    const gold = goldYes(candidate.label);
    const said = says(candidate.slug);

    if (gold === null || said === null) {
      continue;
    }

    compared += 1;

    if (gold !== said) {
      return false;
    }
  }

  return compared === 0 ? null : true;
}

export function gateFigures(gate: UseGate, turns: readonly UseTurn[], laya: ReadonlyMap<string, LayaAnswers>): GateFigures {
  const asked = turns.filter((turn) => turn.candidates.some((one) => one.gate === gate));
  const figures: GateFigures = {
    gate, turns: asked.length, attached: 0, used: 0, related: 0, unused: 0, unlabelledAttached: 0, overSelection: null,
    offered: 0, needed: 0, missTurns: 0, llmAccuracyGold: null, llmMatchGold: 0, llmComparable: 0, laya: null,
  };
  const layaTurns: { confidence: number; gold: boolean | null; llm: boolean }[] = [];

  for (const turn of asked) {
    const mine = turn.candidates.filter((one) => one.gate === gate);
    let missed = false;

    for (const one of mine) {
      if (one.attached) {
        figures.attached += 1;

        if (one.label === "used" || one.label === "related" || one.label === "unused") {
          figures[one.label] += 1;
        } else {
          figures.unlabelledAttached += 1;
        }
      } else {
        figures.offered += 1;

        if (one.label === "needed") {
          figures.needed += 1;
          missed = true;
        }
      }
    }

    figures.missTurns += missed ? 1 : 0;

    const llm = matches(mine, (slug) => mine.find((one) => one.slug === slug)!.llm);

    if (llm !== null) {
      figures.llmComparable += 1;
      figures.llmMatchGold += llm ? 1 : 0;
    }

    const answers = laya.get(`${turn.id}/${gate}`);

    if (answers === undefined || Object.keys(answers).length === 0) {
      continue;
    }

    const confidence = Math.min(...Object.values(answers).map((yes) => Math.max(yes, 1 - yes)));
    const inLaya = (slug: string): boolean | null => slug in answers ? answers[slug]! >= 0.5 : null;
    const llmSet = Object.keys(answers).every((slug) => (mine.find((one) => one.slug === slug)?.llm ?? false) === inLaya(slug));

    layaTurns.push({ confidence, gold: matches(mine, inLaya), llm: llmSet });
  }

  figures.overSelection = share(figures.unused, figures.attached - figures.unlabelledAttached);
  figures.llmAccuracyGold = share(figures.llmMatchGold, figures.llmComparable);

  if (layaTurns.length > 0) {
    figures.laya = {
      turns: layaTurns.length,
      byTau: taus.map((tau) => {
        const settled = layaTurns.filter((one) => one.confidence >= tau);
        const judged = settled.filter((one) => one.gold !== null);
        const matchGold = judged.filter((one) => one.gold === true).length;
        const matchLlm = settled.filter((one) => one.llm).length;

        return {
          tau,
          settled: settled.length,
          share: share(settled.length, layaTurns.length) ?? 0,
          matchGold,
          accuracyGold: share(matchGold, judged.length),
          matchLlm,
          accuracyLlm: share(matchLlm, settled.length),
        };
      }),
    };
  }

  return figures;
}

// The τ at which Laya settles the most turns while holding the bar on both counts, or null.
export function clearingTau(figures: GateFigures, bar: number): TauFigures | null {
  const clearing = (figures.laya?.byTau ?? []).filter((one) =>
    one.tau > 0 && one.settled > 0 && (one.accuracyGold ?? 0) >= bar && (one.accuracyLlm ?? 0) >= bar);

  return clearing.reduce<TauFigures | null>((best, one) => best === null || one.settled > best.settled ? one : best, null);
}

export interface TrainingOutcome {
  rows: FrozenRow[];
  refusals: Partial<Record<SynthRefusal | "no-probe" | "unlabelled", number>>;
}

// The use verdicts as training rows: the turn rebuilt in the plain shape, the turn's own questions
// cut into sets its gate's specification offers, and a gold out of each question's label.
export function trainingRows(gate: UseGate, turns: readonly UseTurn[], shares: SplitShares): TrainingOutcome {
  const spec = specOf(gate);
  const rows: FrozenRow[] = [];
  const refusals: TrainingOutcome["refusals"] = {};
  const count = (why: keyof TrainingOutcome["refusals"]): void => {
    refusals[why] = (refusals[why] ?? 0) + 1;
  };

  for (const turn of turns) {
    const requests = turn.probes[gate] ?? [];

    if (requests.length === 0) {
      if (turn.candidates.some((one) => one.gate === gate)) {
        count("no-probe");
      }

      continue;
    }

    const labels = new Map(turn.candidates.filter((one) => one.gate === gate).map((one) => [one.slug, one.label]));
    const state = turn.lines.join("\n");
    const language = languageOf(stateText(spec, state));

    for (const request of requests) {
      const sets = offeredSets(spec, request.questions);

      if (sets.length === 0) {
        count("candidate-count");
      }

      for (const questions of sets) {
        const gold: Record<string, Gold> = {};
        let whole = true;

        for (const id of Object.keys(questions)) {
          const label = labels.get(candidateOf(spec, id)?.slug ?? "") ?? null;

          if (label === null) {
            whole = false;
            break;
          }

          const yes = goldShare(label);

          gold[id] = { type: "noul", label: yes >= 0.5 ? "true" : "false", noul: yes, probabilities: { true: yes, false: Math.round((1 - yes) * 100) / 100 } };
        }

        if (!whole) {
          count("unlabelled");
          continue;
        }

        const row = { state, questions, gold };
        const verdict = validateSynthRow(spec, row, language);

        if (!verdict.ok) {
          count(verdict.refusal);
          continue;
        }

        rows.push({ row: datasetRowOf(spec, row, shares), language });
      }
    }
  }

  return { rows, refusals };
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
