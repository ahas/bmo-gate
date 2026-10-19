import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitFiles } from "../laya-frozen";
import { addTokens, noTokens } from "../laya-synth-run";
import { allFigures, labelledTurns } from "./figures";
import { judgeBatches, judgeItem, judgePrompt, judgeSystem, readJudgement, turnsToJudge, unjudged } from "./judge";
import { appendLabels, importedLabels, readLabels, referenceGates } from "./labels";
import { answerCounts, referenceRows } from "./rows";

import type { DatasetSplit } from "../laya-dataset";
import type { JudgeRoad } from "../gate-judge";
import type { LayaRequest } from "../laya";
import type { TokenTally } from "../laya-synth-run";
import type { GateFigures, LayaAnswers } from "./figures";
import type { JudgeItem, Wanting } from "./judge";
import type { Label, ReferenceGate } from "./labels";
import type { InputsAsk, InputsReader, LiveTurn } from "./live-inputs";
import type { GateRows } from "./rows";
import type { ReferenceTurn, TurnBuild, TurnSource } from "./turns";

// One pass of the reference gates' data (docs/reference-data.md, 「A run and its folder」): the
// turns, the gate's inputs for them, the labels still wanting judged within the pass's bound, every row
// assembled afresh and put in place whole, Laya asked again, and the figures.

export const labelsFile = "labels.jsonl";
export const instructionTurnsFile = "instruction-turns.jsonl";
export const gatesFolder = "gates";
export const gateDataFile = "data.json";

// How many turns one pass judges at most.
export const judgedPerPass = 60;

export interface LayaService {
  // The checkpoint serving each gate now.
  served: ReadonlyMap<string, string>;
  ask: (gate: ReferenceGate, request: LayaRequest) => Promise<LayaAnswers | null>;
}

export interface TickOptions {
  root: string;
  built: TurnBuild;
  inputs: InputsReader;
  // The road the judge is asked on, or null for a pass that judges nothing, and what that judge is —
  // its road, model and effort, and its account where it rides one — as every batch it freezes says.
  road: JudgeRoad | null;
  judge?: string;
  // Which pieces the pass asks about; an ordinary pass asks about what has no label.
  wanting?: Wanting;
  // The sources of the turns the pass judges; every source where none is named.
  sources?: readonly TurnSource[];
  judged: number;
  atOnce: number;
  // The turn's messages as the judge reads them, and a text or an input as it leaves the room.
  messages: (turn: ReferenceTurn) => string[];
  leaveText: (text: string) => string;
  leaveRequest: (request: LayaRequest) => LayaRequest;
  laya: LayaService | null;
  // The version of the gate whose command built the inputs.
  gateVersion: string | null;
  // The conversation snapshot the pass read: when it was taken.
  snapshot: SnapshotStamp | null;
  // The first judging's turn file, whose labels are taken in once.
  importFrom: string | null;
  now?: () => Date;
  say?: (line: string) => void;
}

export interface SnapshotStamp {
  takenAt: string;
}

export interface GateData {
  gate: ReferenceGate;
  rows: Record<DatasetSplit, number>;
  waiting: number;
  unlabelled: number;
  cut: number;
  refused: GateRows["refused"];
  yes: number;
  no: number;
  contested: number;
  rowsWithYes: number;
  digest: string;
}

export interface TickReport {
  at: string;
  gateVersion: string | null;
  snapshot: SnapshotStamp | null;
  turns: number;
  skipped: TurnBuild["skipped"] & { missing: number };
  wanting: number;
  judgedTurns: number;
  calls: number;
  failedBatches: number;
  tokens: TokenTally;
  imported: number;
  labels: number;
  layaAsked: number;
  layaReused: number;
  layaFailed: number;
  gates: GateData[];
  figures: GateFigures[];
  recordFigures: GateFigures[];
}

interface FrozenJudgement {
  judge?: string;
  items: JudgeItem[];
  answer: string;
  tokens: TokenTally;
  labels: Label[];
}

function nextBatch(folder: string): number {
  return existsSync(folder)
    ? readdirSync(folder).filter((file) => /^\d+\.json$/.test(file)).reduce((most, file) => Math.max(most, Number(file.slice(0, -5)) + 1), 0)
    : 0;
}

// Every gate's rows written under a partial name and put in place in one rename, so a training pass
// reads one pass's rows and never half of two.
export function writeGates(root: string, built: Record<ReferenceGate, GateRows>): GateData[] {
  const partial = join(root, `${gatesFolder}.partial`);
  const standing = join(root, gatesFolder);
  const old = join(root, `${gatesFolder}.old`);

  rmSync(partial, { recursive: true, force: true });

  const data = referenceGates.map((gate): GateData => {
    const folder = join(partial, gate);
    const rows = { train: 0, calibration: 0, test: 0 } as Record<DatasetSplit, number>;
    const digest = createHash("sha256");

    mkdirSync(folder, { recursive: true });

    for (const [split, file] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
      const lines = built[gate].rows.filter((row) => row.split === split).map((row) => JSON.stringify(row));
      const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;

      rows[split] = lines.length;
      digest.update(text);
      writeFileSync(join(folder, file), text);
    }

    const { yes, no, contested, rowsWithYes } = answerCounts(built[gate].rows);
    const gateData: GateData = {
      gate, rows,
      waiting: built[gate].waiting, unlabelled: built[gate].unlabelled, cut: built[gate].cut, refused: built[gate].refused,
      yes, no, contested, rowsWithYes,
      digest: digest.digest("hex").slice(0, 16),
    };

    writeFileSync(join(folder, gateDataFile), `${JSON.stringify(gateData, null, 2)}\n`);

    return gateData;
  });

  rmSync(old, { recursive: true, force: true });

  if (existsSync(standing)) {
    renameSync(standing, old);
  }

  renameSync(partial, standing);
  rmSync(old, { recursive: true, force: true });

  return data;
}

// What the gate is asked for one turn: its room, its messages, and the instructions it was handed.
function askOf(turn: ReferenceTurn): InputsAsk {
  return {
    chatId: turn.chatId,
    messageIds: turn.messageIds,
    ...turn.instructions === undefined ? {} : { instructions: turn.instructions },
    ...turn.work === undefined ? {} : { work: turn.work },
  };
}

interface KeptTurn {
  key: string;
  chatId: number;
  at: number;
  instructions: string;
  reply: string;
  attached: string[];
}

// The turns the bot's own instructions opened, kept once read, since the agency's run log lets them
// go after a week: each one read now and not yet kept is appended, and every one kept that the
// snapshot no longer holds joins the turns read (docs/reference-data.md, 「The turns」).
export function withKeptTurns(root: string, read: readonly ReferenceTurn[]): ReferenceTurn[] {
  const file = join(root, instructionTurnsFile);
  const kept = new Map<string, ReferenceTurn>();

  for (const line of existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((one) => one.trim() !== "") : []) {
    const one = JSON.parse(line) as KeptTurn;

    kept.set(one.key, {
      key: one.key, chatId: one.chatId, messageIds: [], at: one.at, source: "instructions",
      attached: new Set(one.attached), reply: one.reply, recorded: [], instructions: one.instructions,
    });
  }

  const fresh = read.filter((turn) => turn.source === "instructions" && !kept.has(turn.key));

  if (fresh.length > 0) {
    appendFileSync(file, fresh.map((turn) => `${JSON.stringify({
      key: turn.key, chatId: turn.chatId, at: turn.at, instructions: turn.instructions ?? "", reply: turn.reply, attached: [...turn.attached ?? []],
    } satisfies KeptTurn)}\n`).join(""));
  }

  const standing = new Set(read.map((turn) => turn.key));

  return [...read, ...[...kept.values()].filter((turn) => !standing.has(turn.key))].sort((left, right) => right.at - left.at);
}

function hashOf(request: LayaRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16);
}

type Chosen = { turn: ReferenceTurn; wanted: ReturnType<typeof unjudged> };

// The chosen turns judged: their pieces' bodies asked of the gate, the items cut into batches, a few
// batches at a time on the road, and each batch frozen and its labels appended the moment it lands.
async function judgeTurns(
  chosen: readonly Chosen[],
  road: JudgeRoad,
  options: Pick<TickOptions, "inputs" | "messages" | "leaveText" | "atOnce" | "now" | "say" | "judge">,
  judgedFolder: string,
  labelsPath: string,
): Promise<{ calls: number; judgedTurns: number; failedBatches: number; tokens: TokenTally }> {
  const now = options.now ?? (() => new Date());
  const say = options.say ?? (() => {});
  const withBodies = options.inputs(chosen.map((one): InputsAsk => ({
    ...askOf(one.turn),
    bodies: Object.fromEntries(referenceGates.map((gate) => [gate, one.wanted.filter((piece) => piece.gate === gate && piece.attached).map((piece) => piece.slug)])),
  })));
  const items = chosen.map((one, index) =>
    judgeItem(one.turn, options.messages(one.turn), one.wanted, withBodies[index]!, options.leaveText));
  const plan = judgeBatches(items);
  const base = nextBatch(judgedFolder);
  const spent = { calls: 0, judgedTurns: 0, failedBatches: 0, tokens: noTokens };

  mkdirSync(judgedFolder, { recursive: true });

  const judge = async (batch: JudgeItem[], index: number): Promise<void> => {
    try {
      const answer = await road(judgeSystem(), judgePrompt(batch), null);
      const read = readJudgement(answer.text, batch, base + index, now().toISOString());
      const frozen: FrozenJudgement = { ...options.judge === undefined ? {} : { judge: options.judge }, items: batch, answer: answer.text, tokens: answer.tokens, labels: read };

      writeFileSync(join(judgedFolder, `${String(base + index).padStart(5, "0")}.json`), `${JSON.stringify(frozen)}\n`);
      appendLabels(labelsPath, read);
      spent.tokens = addTokens(spent.tokens, answer.tokens);
      spent.calls += 1;
      spent.judgedTurns += batch.length;
      say(`judging batch ${index + 1}/${plan.length}: ${read.length} labels`);
    } catch (error) {
      spent.failedBatches += 1;
      say(`judging batch ${index + 1}/${plan.length} failed: ${(error as Error).message}`);
    }
  };

  // A failed batch ends the judging: the ones under way land, and no further batch is started, so a
  // spent limit is met once rather than once for every batch left.
  for (let next = 0; next < plan.length && spent.failedBatches === 0; next += options.atOnce) {
    await Promise.all(plan.slice(next, next + options.atOnce).map((batch, offset) => judge(batch, next + offset)));
  }

  if (spent.failedBatches > 0 && spent.calls + spent.failedBatches < plan.length) {
    say(`a judging batch failed, so ${plan.length - spent.calls - spent.failedBatches} batches were not started.`);
  }

  return spent;
}

// Laya asked again, gate by gate rather than turn by turn, since the service keeps a checkpoint on
// the card once its gate has asked. An answer is reused while the same checkpoint serves the gate and
// the turn's input has not changed.
async function askLayaAgain(
  layaFile: string,
  turns: readonly { key: string; gates: readonly { gate: ReferenceGate; request: LayaRequest }[] }[],
  service: LayaService,
): Promise<{ laya: Map<string, LayaAnswers>; asked: number; reused: number; failed: number }> {
  const answered = new Map<string, { model: string; input: string; answers: LayaAnswers }>();

  for (const line of existsSync(layaFile) ? readFileSync(layaFile, "utf8").split("\n").filter((one) => one.trim() !== "") : []) {
    const said = JSON.parse(line) as { key: string; model: string; input: string; answers: LayaAnswers };

    answered.set(said.key, said);
  }

  const counted = { laya: new Map<string, LayaAnswers>(), asked: 0, reused: 0, failed: 0 };

  for (const gate of referenceGates) {
    const model = service.served.get(gate);

    if (model === undefined) {
      continue;
    }

    for (const turn of turns) {
      const request = turn.gates.find((one) => one.gate === gate)?.request;

      if (request === undefined) {
        continue;
      }

      const key = `${turn.key}/${gate}`;
      const input = hashOf(request);
      const kept = answered.get(key);

      if (kept !== undefined && kept.model === model && kept.input === input) {
        counted.reused += 1;
        counted.laya.set(key, kept.answers);
        continue;
      }

      const answers = await service.ask(gate, request);

      counted.asked += 1;

      if (answers === null) {
        counted.failed += 1;
        continue;
      }

      counted.laya.set(key, answers);
      answered.set(key, { model, input, answers });
    }
  }

  writeFileSync(layaFile, [...answered].map(([key, one]) => `${JSON.stringify({ key, ...one })}\n`).join(""));

  return counted;
}

export async function referenceTick(options: TickOptions): Promise<TickReport> {
  const now = options.now ?? (() => new Date());
  const say = options.say ?? (() => {});
  const at = now().toISOString();
  const labelsPath = join(options.root, labelsFile);
  const judgedFolder = join(options.root, "judged");

  mkdirSync(options.root, { recursive: true });

  let labels = readLabels(labelsPath);
  let imported = 0;

  if (labels.size === 0 && options.importFrom !== null) {
    const taken = importedLabels(options.importFrom, at);

    appendLabels(labelsPath, taken);
    imported = taken.length;
    labels = readLabels(labelsPath);
    say(`${imported} labels of the first judging taken in.`);
  }

  const turns = withKeptTurns(options.root, options.built.turns);
  const live = options.inputs(turns.map(askOf));
  const missing = live.filter((one) => one.missing).length;
  const wanting = turns.map((turn, index) => ({ turn, live: live[index]!, wanted: unjudged(turn, live[index]!, labels, options.wanting) }));
  const judgeable = wanting.filter((one) => !one.live.missing && (options.sources === undefined || options.sources.includes(one.turn.source)));
  const chosen = options.road === null ? [] : turnsToJudge(judgeable, options.judged);

  say(`${turns.length} turns · ${wanting.filter((one) => one.wanted.length > 0).length} turns wanting labels · ${chosen.length} turns judged this pass`);

  const { calls, judgedTurns, failedBatches, tokens } = options.road === null || chosen.length === 0
    ? { calls: 0, judgedTurns: 0, failedBatches: 0, tokens: noTokens }
    : await judgeTurns(chosen, options.road, options, judgedFolder, labelsPath);

  labels = readLabels(labelsPath);

  const built = referenceRows(turns.map((turn, index) => ({ key: turn.key, source: turn.source, gates: live[index]!.gates })), labels, options.leaveRequest);
  const gates = writeGates(options.root, built);
  const { laya, asked: layaAsked, reused: layaReused, failed: layaFailed } = options.laya === null
    ? { laya: new Map<string, LayaAnswers>(), asked: 0, reused: 0, failed: 0 }
    : await askLayaAgain(join(options.root, "laya.jsonl"), turns.map((turn, index) => ({ key: turn.key, gates: live[index]!.gates })), options.laya);
  const standing = [...labels.values()];
  const figureTurns = labelledTurns(turns.map((turn) => ({ key: turn.key, recorded: turn.recorded })), standing);
  const report: TickReport = {
    at,
    gateVersion: options.gateVersion,
    snapshot: options.snapshot,
    turns: turns.length,
    skipped: { ...options.built.skipped, missing },
    wanting: wanting.filter((one) => one.wanted.length > 0).length,
    judgedTurns,
    calls,
    failedBatches,
    tokens,
    imported,
    labels: standing.length,
    layaAsked,
    layaReused,
    layaFailed,
    gates,
    figures: allFigures(figureTurns, standing, laya),
    recordFigures: allFigures(figureTurns.filter((turn) => turn.recorded.length > 0), standing, laya),
  };

  writeFileSync(join(options.root, "turns.jsonl"), turns.map((turn, index) => `${JSON.stringify({
    key: turn.key,
    source: turn.source,
    messageIds: turn.messageIds,
    attachedKnown: turn.attached !== null,
    missing: live[index]!.missing,
    gates: live[index]!.gates.map((one) => ({ gate: one.gate, candidates: one.candidates.length })),
  })}\n`).join(""));
  writeFileSync(join(options.root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  appendFileSync(join(options.root, "ticks.jsonl"), `${JSON.stringify({
    at, gateVersion: report.gateVersion, snapshot: report.snapshot, turns: report.turns, wanting: report.wanting, judgedTurns: report.judgedTurns, calls, failedBatches, tokens,
    labels: report.labels, layaAsked, layaReused, layaFailed,
  })}\n`);

  return report;
}
