import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { frozenHere, refuseOverwrite, splitFiles, whatStands } from "./laya-frozen";
import { answersOf, datasetRowOf, languageBuckets, languageOf, readSynthBatch, roomKinds, stateText, synthPrefix, synthSuffix, validateSynthRow } from "./laya-synth";

import type { HarnessRun } from "./harness";
import type { DatasetRow, DatasetSplit, SplitShares } from "./laya-dataset";
import type { GateSynthesis, LanguageBucket, SynthAsk, SynthRefusal } from "./laya-synth";

// The driving half of the distilled data: what one batch is asked, where a landed batch is kept,
// and how the batches become the three frozen files (docs/laya-gates.md). The model call itself is
// handed in, so the whole run can be driven end to end without one.
//
// A batch is frozen the moment it lands, and a run that dies is resumed from the batch after the
// last frozen one. The plan is a pure function of the gate, the row count and the batch size, so a
// resumed run asks for exactly what the dead one would have asked for next.

// Which road the rows are written on. The two differ in more than their model: one holds a session
// across a gate's batches and reads its fixed prefix out of the prompt cache, and the other keeps
// no session at all and reads the whole prefix afresh on every call.
export type SynthRoad = "claude" | "codex" | "j3090";

export function roadHoldsSession(road: SynthRoad): boolean {
  return road !== "j3090";
}

export interface TokenTally {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const noTokens: TokenTally = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addTokens(one: TokenTally, other: TokenTally): TokenTally {
  return {
    inputTokens: one.inputTokens + other.inputTokens,
    outputTokens: one.outputTokens + other.outputTokens,
    cacheReadTokens: one.cacheReadTokens + other.cacheReadTokens,
    cacheWriteTokens: one.cacheWriteTokens + other.cacheWriteTokens,
  };
}

// What a batch asked for and what it got back, as the driver hands it on.
export interface SynthAnswer {
  text: string;
  sessionId: string | null;
  tokens: TokenTally;
}

export type SynthAsker = (spec: GateSynthesis, ask: SynthAsk, resumeSessionId: string | null) => Promise<SynthAnswer>;

// The run one batch is, as this repository's own harness reads a run. It keeps its session so the
// next batch of the same gate resumes it and reads the fixed prefix out of the cache rather than
// afresh; `teacherRun` keeps none, which is right for a one-shot judgement and wrong here.
export function synthRun(
  model: string,
  effort: string,
  systemPromptPath: string,
  prompt: string,
  resumeSessionId: string | null,
  cwd: string,
  env: Record<string, string | undefined>,
): HarnessRun {
  return {
    line: "gate",
    model,
    effort,
    systemPromptPath,
    toolsShown: "",
    toolsAllowed: null,
    toolsDenied: null,
    mcpConfigPath: null,
    prompt,
    promptDelivery: "input",
    resumeSessionId,
    keepSession: true,
    hostCommands: false,
    thinking: true,
    answerShape: "object",
    cwd,
    env,
  };
}

// A fixed stride over the batches, so the languages are interleaved rather than written in three
// blocks: a run stopped halfway then holds something of every language instead of all of one.
const stride = 7_919;

function languageAt(spec: GateSynthesis, place: number, howMany: number): LanguageBucket {
  const at = (((place * stride) % howMany) + 0.5) / howMany;
  let walked = 0;

  for (const bucket of languageBuckets) {
    walked += spec.language[bucket];

    if (at < walked) {
      return bucket;
    }
  }

  return "korean";
}

// Every batch one gate's run asks for, in order. It is a pure function of the gate, the rows wanted
// and the batch size, so a resumed run takes up the plan exactly where the dead one left it.
export function plannedBatches(spec: GateSynthesis, rows: number, batchSize: number): SynthAsk[] {
  const size = Math.max(1, batchSize);
  const batches = Math.max(1, Math.ceil(Math.max(1, rows) / size));
  const answers = answersOf(spec.questions[0]!);
  const asks: SynthAsk[] = [];

  for (let index = 0; index < batches; index += 1) {
    const answer = answers[index % answers.length]!;
    // The language is drawn within the batches that lean on this same answer, never across all of
    // them. Drawn across all of them the two line up at small batch counts — every batch of one
    // answer taking one language — and then anything that costs a language its batches costs that
    // answer every row it had.
    const among = Math.max(1, Math.ceil((batches - (index % answers.length)) / answers.length));

    asks.push({
      gate: spec.gate,
      count: Math.min(size, Math.max(1, rows) - index * size),
      language: languageAt(spec, Math.floor(index / answers.length), among),
      lean: spec.questions[0]!.type === "noul" ? answer === "true" : answer,
      room: roomKinds[index % roomKinds.length]!,
      // A third of the batches are the hard cases, which is where an asymmetric gate is decided.
      edge: index % 3 === 2,
      seed: `${spec.gate}-${index + 1}`,
    });
  }

  return asks;
}

// One landed row, kept with the language its batch asked for, because a `DatasetRow` has nowhere to
// put it and is not this item's to change.
export interface FrozenRow {
  row: DatasetRow;
  language: LanguageBucket;
}

export interface GateProgress {
  // How many of this gate's planned batches have landed and been frozen.
  done: number;
  // The session those batches rode, which the next batch resumes.
  sessionId: string | null;
  kept: number;
  refused: Record<string, number>;
  unreadable: number;
  // Batches whose answer held no list of rows at all — the shape a batch too large for its road's
  // answer slot comes back in. Counted, because a run that loses every batch this way would
  // otherwise finish quietly with nothing in it.
  lostBatches: number;
  // Batches whose rows came back around a broken list and were read out one at a time. Nothing was
  // lost; a gate doing this on every batch is asking for more rows at a time than the model can
  // hold together, and the count is what makes that visible.
  mendedBatches?: number;
  tokens: TokenTally;
}

export interface SynthProgress {
  started: string;
  model: string;
  effort: string;
  road: SynthRoad;
  rows: number;
  batchSize: number;
  shares: SplitShares;
  gates: Record<string, GateProgress>;
}

export const progressFile = "progress.json";
export const metaFile = "synth.meta.json";
export const languageFile = "languages.jsonl";
export const batchesFolder = "batches";

export type FrozenState = "empty" | "in-progress" | "frozen";

export function frozenState(folder: string): FrozenState {
  if (frozenHere(folder)) {
    return "frozen";
  }

  return existsSync(join(folder, progressFile)) ? "in-progress" : "empty";
}

// A frozen dataset is never written over by accident: a folder that already holds one, or a run
// that was left half-written, is refused unless the run says outright which of the two it means.
// The frozen case is the same refusal the other two writers of such a folder give; only the
// half-written case is this one's own, since only this one can take up where it left off.
export function guardFolder(folder: string, wants: { resume: boolean; overwrite: boolean }): string | null {
  const state = frozenState(folder);

  if (state === "frozen") {
    return refuseOverwrite(folder, wants.overwrite);
  }

  if (state === "in-progress" && !wants.resume && !wants.overwrite) {
    return [
      `${folder} 에 중간까지 쓰다 만 실행이 있습니다: ${whatStands(folder).join(", ")}`,
      "이어서 만들려면 --resume 을, 처음부터 다시 만들려면 --overwrite 를 주세요.",
    ].join("\n");
  }

  return null;
}

export function readProgress(folder: string): SynthProgress | null {
  const path = join(folder, progressFile);

  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SynthProgress : null;
}

// A file a reader may trust the moment it can see it. The bytes go to a name beside the real one
// and are renamed onto it, and a rename inside one directory either happened or did not, so a run
// killed mid-write leaves the old file or no file and never half of a new one. Everything a
// stopped run leaves behind for the next one to read goes through here, because a resumed run
// treats what stands on disk as fact and a truncated file would be a lie it has no way to catch.
//
// The name beside it is hidden, so a refusal listing what stands in a folder never names the
// leavings of a write instead of a dataset.
function writeWhole(path: string, text: string): void {
  const beside = join(dirname(path), `.${basename(path)}.writing`);

  writeFileSync(beside, text);

  try {
    renameSync(beside, path);
  } catch (trouble) {
    rmSync(beside, { force: true });

    throw trouble;
  }
}

export function writeProgress(folder: string, progress: SynthProgress): void {
  mkdirSync(folder, { recursive: true });
  writeWhole(join(folder, progressFile), `${JSON.stringify(progress, null, 2)}\n`);
}

export function batchName(gate: string, index: number): string {
  return `${gate}-${String(index + 1).padStart(4, "0")}.jsonl`;
}

function batchPath(folder: string, gate: string, index: number): string {
  return join(folder, batchesFolder, batchName(gate, index));
}

// A batch is written the moment it lands, so nothing a model has already answered is asked twice.
export function freezeBatch(folder: string, gate: string, index: number, rows: readonly FrozenRow[]): void {
  mkdirSync(join(folder, batchesFolder), { recursive: true });
  writeWhole(batchPath(folder, gate, index), rows.map((one) => JSON.stringify(one)).join("\n") + (rows.length > 0 ? "\n" : ""));
}

export function lostAnswerName(gate: string, index: number): string {
  return `${gate}-${String(index + 1).padStart(4, "0")}.lost.txt`;
}

// An answer whose rows had to be read out one at a time. Kept like a lost one, and named apart
// from it: nothing was lost here, but a gate mending every answer is a gate asking for more rows
// at a time than the model can close its brackets around, and that is only visible if it is said.
export function mendedAnswerName(gate: string, index: number): string {
  return `${gate}-${String(index + 1).padStart(4, "0")}.mended.txt`;
}

// What a batch answered when nothing could be read out of it. Kept whole, because the shape of the
// answer is the only thing that says why — an answer cut off mid-list, a model that wrote prose
// instead, a refusal — and none of those can be told apart from a count.
export function keepLostAnswer(folder: string, gate: string, index: number, answer: string): void {
  mkdirSync(join(folder, batchesFolder), { recursive: true });
  writeWhole(join(folder, batchesFolder, lostAnswerName(gate, index)), answer);
}

export function keepMendedAnswer(folder: string, gate: string, index: number, answer: string): void {
  mkdirSync(join(folder, batchesFolder), { recursive: true });
  writeWhole(join(folder, batchesFolder, mendedAnswerName(gate, index)), answer);
}

// An answer that read perfectly well and left no row standing. Kept for the same reason a lost one
// is: a gate that comes back empty has to be answerable afterwards, and the answer is the only
// thing that says whether the model wrote nothing, wrote the wrong shape, or wrote rows the gate
// refused. Without it a gate that produced nothing can only be guessed at.
export function barrenAnswerName(gate: string, index: number): string {
  return `${gate}-${String(index + 1).padStart(4, "0")}.barren.txt`;
}

export function keepBarrenAnswer(folder: string, gate: string, index: number, answer: string): void {
  mkdirSync(join(folder, batchesFolder), { recursive: true });
  writeWhole(join(folder, batchesFolder, barrenAnswerName(gate, index)), answer);
}

// How far a gate actually got, read off the batches standing in the folder rather than off the
// count a run recorded of itself. The two part company whenever a run is killed between freezing
// a batch and writing down that it did: the file stands, the count does not know it, and a
// resumed run trusting the count would ask the model for that batch a second time and write the
// answer over rows that were already good.
//
// Counting stops at the first batch that is missing rather than counting the files. A gap means
// the batches past it belong to some other plan, and taking them would leave the run with a hole
// in the middle it can never fill.
//
// Only what the files themselves say is taken. The rows kept are in them and are counted; the
// lost answers stand beside them and are counted; what a batch refused and what it cost were
// never written anywhere but the count, so a batch the count never heard of takes those to the
// grave. Reconciling the two that can be read is not a reason to invent the two that cannot.
export function gateOnDisk(folder: string, gate: string, plan: number): { done: number; kept: number; lost: number } {
  let done = 0;
  let kept = 0;
  let lost = 0;

  while (done < plan && existsSync(batchPath(folder, gate, done))) {
    kept += readFileSync(batchPath(folder, gate, done), "utf8").split("\n").filter((line) => line.trim() !== "").length;

    if (existsSync(join(folder, batchesFolder, lostAnswerName(gate, done)))) {
      lost += 1;
    }

    done += 1;
  }

  return { done, kept, lost };
}

export function readFrozenBatches(folder: string): FrozenRow[] {
  const dir = join(folder, batchesFolder);

  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().flatMap((name) =>
    readFileSync(join(dir, name), "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as FrozenRow));
}

export interface GateFigures {
  gate: string;
  rows: number;
  splits: Record<DatasetSplit, number>;
  // What share of this gate's questions each answer came out as, against the even split the
  // specification draws to.
  balance: Record<string, number>;
  language: Record<LanguageBucket, number>;
  kept: number;
  refused: Record<string, number>;
  unreadable: number;
  lostBatches: number;
  duplicates: number;
  tokens: TokenTally;
  // Whether this gate's batches rode one session, and so whether its prefix was read from the
  // cache rather than afresh. The J3090 road keeps no session and reuses no cache.
  sessionHeld: boolean;
}

export interface SynthMeta {
  model: string;
  effort: string;
  road: SynthRoad;
  // The two things the J3090 road cannot do, said outright rather than left to be inferred from
  // a cache-read count of zero.
  sessionHeld: boolean;
  cacheReused: boolean;
  written: string;
  started: string;
  rowsAsked: number;
  batchSize: number;
  shares: SplitShares;
  gates: GateFigures[];
  tokens: TokenTally;
}

// The batches become the three files: every row once, the duplicates counted rather than written
// twice, and the language of each row kept beside them under its id.
export function freezeSplits(folder: string, progress: SynthProgress): SynthMeta {
  const frozen = readFrozenBatches(folder);
  const seen = new Map<string, FrozenRow>();
  const duplicates = new Map<string, number>();

  for (const one of frozen) {
    if (seen.has(one.row.id)) {
      duplicates.set(one.row.gate, (duplicates.get(one.row.gate) ?? 0) + 1);
    } else {
      seen.set(one.row.id, one);
    }
  }

  const kept = [...seen.values()];

  for (const [split, name] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
    const rows = kept.filter((one) => one.row.split === split).map((one) => JSON.stringify(one.row));

    writeFileSync(join(folder, name), rows.length === 0 ? "" : `${rows.join("\n")}\n`);
  }

  const languages = kept.map((one) => JSON.stringify({ id: one.row.id, language: one.language }));

  writeFileSync(join(folder, languageFile), languages.length === 0 ? "" : `${languages.join("\n")}\n`);

  const meta: SynthMeta = {
    model: progress.model,
    effort: progress.effort,
    road: progress.road,
    sessionHeld: roadHoldsSession(progress.road),
    cacheReused: roadHoldsSession(progress.road),
    written: new Date().toISOString(),
    started: progress.started,
    rowsAsked: progress.rows,
    batchSize: progress.batchSize,
    shares: progress.shares,
    gates: Object.keys(progress.gates).sort().map((gate) => figuresFor(gate, kept, progress, duplicates.get(gate) ?? 0)),
    tokens: Object.values(progress.gates).reduce((all, one) => addTokens(all, one.tokens), noTokens),
  };

  writeFileSync(join(folder, metaFile), `${JSON.stringify(meta, null, 2)}\n`);

  return meta;
}

function figuresFor(gate: string, kept: readonly FrozenRow[], progress: SynthProgress, duplicates: number): GateFigures {
  const mine = kept.filter((one) => one.row.gate === gate);
  const splits: Record<DatasetSplit, number> = { train: 0, calibration: 0, test: 0 };
  const balance: Record<string, number> = {};
  const language: Record<LanguageBucket, number> = { korean: 0, english: 0, mixed: 0 };
  let answered = 0;

  for (const one of mine) {
    splits[one.row.split] += 1;
    language[one.language] += 1;

    for (const gold of Object.values(JSON.parse(one.row.gold) as Record<string, { label: string }>)) {
      balance[gold.label] = (balance[gold.label] ?? 0) + 1;
      answered += 1;
    }
  }

  const held = progress.gates[gate];

  return {
    gate,
    rows: mine.length,
    splits,
    balance: Object.fromEntries(Object.entries(balance).map(([answer, count]) => [answer, share(count, answered)])),
    language: {
      korean: share(language.korean, mine.length),
      english: share(language.english, mine.length),
      mixed: share(language.mixed, mine.length),
    },
    kept: held?.kept ?? mine.length,
    refused: held?.refused ?? {},
    unreadable: held?.unreadable ?? 0,
    lostBatches: held?.lostBatches ?? 0,
    duplicates,
    tokens: held?.tokens ?? noTokens,
    sessionHeld: roadHoldsSession(progress.road) && held?.sessionId != null,
  };
}

function share(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 10_000) / 10_000;
}

export interface SynthOptions {
  folder: string;
  gates: readonly GateSynthesis[];
  rows: number;
  batchSize: number;
  model: string;
  effort: string;
  road: SynthRoad;
  shares: SplitShares;
  resume: boolean;
  say?: (line: string) => void;
}

export interface SynthReport {
  meta: SynthMeta;
  // The batches this run asked for, which is fewer than the plan where it resumed into one already
  // part-written.
  asked: number;
}

// The whole run: every gate, every batch of its plan, frozen as it lands. Nothing here knows how a
// model is reached — that is the asker's, so a run can be driven end to end without one.
export async function runSynthesis(options: SynthOptions, ask: SynthAsker): Promise<SynthReport> {
  const say = options.say ?? (() => {});
  const held = options.resume ? readProgress(options.folder) : null;
  const progress: SynthProgress = held ?? {
    started: new Date().toISOString(),
    model: options.model,
    effort: options.effort,
    road: options.road,
    rows: options.rows,
    batchSize: options.batchSize,
    shares: options.shares,
    gates: {},
  };

  if (!roadHoldsSession(options.road)) {
    say("이 길은 세션을 붙들지 않습니다. 묶음마다 프롬프트를 처음부터 다시 읽으므로 캐시를 쓰지 못합니다.");
  }

  let asked = 0;

  for (const spec of options.gates) {
    const plan = plannedBatches(spec, progress.rows, progress.batchSize);
    const state = progress.gates[spec.gate] ?? { done: 0, sessionId: null, kept: 0, refused: {}, unreadable: 0, lostBatches: 0, tokens: noTokens };

    state.lostBatches ??= 0;

    progress.gates[spec.gate] = state;

    // What is on disk settles where a resumed run takes up, because a batch that was frozen is a
    // batch the model has already answered whether or not the count caught up before the run
    // died. A run told to start over is not reconciled: its folder's batches belong to the run it
    // is replacing, and reading them would turn an overwrite into a resume.
    if (options.resume) {
      const stands = gateOnDisk(options.folder, spec.gate, plan.length);

      if (stands.done !== state.done) {
        say(`${spec.gate}: 굳은 묶음은 ${stands.done}개인데 기록은 ${state.done}개입니다 — 굳은 쪽을 따릅니다.`);
      }

      state.done = stands.done;
      state.kept = stands.kept;
      state.lostBatches = stands.lost;
    }

    if (state.done > 0) {
      say(`${spec.gate}: ${state.done}묶음까지 굳어 있어 그다음부터 이어 만듭니다.`);
    }

    for (let index = state.done; index < plan.length; index += 1) {
      const answer = await ask(spec, plan[index]!, roadHoldsSession(options.road) ? state.sessionId : null);

      asked += 1;
      state.tokens = addTokens(state.tokens, answer.tokens);

      if (roadHoldsSession(options.road) && answer.sessionId !== null) {
        state.sessionId = answer.sessionId;
      }

      const reading = readSynthBatch(answer.text);
      const rows: FrozenRow[] = [];

      state.unreadable += reading.unreadable;

      if (!reading.readable) {
        state.lostBatches += 1;
        // The answer is kept beside the batch it should have been. A lost batch that leaves
        // nothing behind can only be guessed at afterwards, and the guess is usually wrong.
        keepLostAnswer(options.folder, spec.gate, index, answer.text);
        say(`${spec.gate} ${index + 1}/${plan.length}: 답에 행 목록이 없습니다 — 묶음이 통째로 날아갔습니다. 답은 ${lostAnswerName(spec.gate, index)} 에 남겼습니다.`);
      } else if (reading.salvaged) {
        // Nothing was lost, but the list came back broken and the rows were read out of it one at
        // a time. The answer is kept so the break can be looked at rather than inferred.
        state.mendedBatches = (state.mendedBatches ?? 0) + 1;
        keepMendedAnswer(options.folder, spec.gate, index, answer.text);
        say(`${spec.gate} ${index + 1}/${plan.length}: 목록이 온전하지 않아 행을 하나씩 건졌습니다. 답은 ${mendedAnswerName(spec.gate, index)} 에 남겼습니다.`);
      }

      for (const row of reading.rows) {
        const verdict = validateSynthRow(spec, row, plan[index]!.language);

        if (verdict.ok) {
          rows.push({ row: datasetRowOf(spec, row, progress.shares), language: languageOf(stateText(spec, row.state)) });
        } else {
          state.refused[verdict.refusal] = (state.refused[verdict.refusal] ?? 0) + 1;
        }
      }

      // A batch that read and kept nothing is kept too. Whatever went wrong is in the answer and
      // nowhere else, and a gate that comes back empty is a gate somebody has to account for.
      if (rows.length === 0 && reading.readable && !reading.salvaged) {
        keepBarrenAnswer(options.folder, spec.gate, index, answer.text);
        say(`${spec.gate} ${index + 1}/${plan.length}: 읽히긴 했는데 남은 행이 없습니다. 답은 ${barrenAnswerName(spec.gate, index)} 에 남겼습니다.`);
      }

      state.kept += rows.length;
      freezeBatch(options.folder, spec.gate, index, rows);
      state.done = index + 1;
      writeProgress(options.folder, progress);
      say(`${spec.gate} ${index + 1}/${plan.length}: ${rows.length}행 굳힘 (지금까지 ${state.kept}행)`);
    }
  }

  return { meta: freezeSplits(options.folder, progress), asked };
}

// The prompt one batch carries: the gate's own fixed prefix, which is the system prompt and so the
// thing a held session reads out of the cache, and the batch's own ask behind it.
export function batchPrompts(spec: GateSynthesis, ask: SynthAsk): { system: string; prompt: string } {
  return { system: synthPrefix(spec), prompt: synthSuffix(spec, ask) };
}
