import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitFiles } from "./laya-frozen";
import { jakeExecArgs, jakeUploadArgs, homeCommand, nodePath, parseHome, printedWidth } from "./laya-nodes";
import { rehearsalFolder, runWord } from "./laya-rehearsal";
import { synthesisFor } from "./laya-synth";

import type { DatasetSplit } from "./laya-dataset";
import type { NodeRunner, RunResult } from "./laya-nodes";

// One gate to one node, the ten gates over two rounds (docs/laya-train-run.md, 「One gate to a node,
// two rounds」). This is the driver: it cuts the dataset into one folder a gate, puts a gate's folder
// on the node that will train it, starts the training detached, watches the log, carries on a run
// that died from its newest step checkpoint rather than from the base model, calibrates what
// finished, and writes down for every gate what it cost — which is the per-node table in raw form.
//
// The shell of a run lives in the committed `node-train.sh`; what is here composes the calls, reads
// what comes back, and decides what to do next. Everything but the running is therefore read without
// a node.

export const TRAIN_SCRIPT = "node-train.sh";

/** The ledger file a run writes, which the verification table is assembled from. */
export const trainLedgerFile = "ledger.json";

export interface GateDataset {
  gate: string;
  folder: string;
  rows: Record<DatasetSplit, number>;
}

/** One gate's own three splits, cut out of a dataset that holds all ten. The training reads a folder
 * and trains on every gate in it, so a gate is given a node by giving that node a folder with only
 * that gate's rows in it. */
export function writeGateDataset(from: string, gate: string, to: string): GateDataset | string {
  const rows: Record<DatasetSplit, number> = { train: 0, calibration: 0, test: 0 };
  const kept: Record<string, string[]> = {};

  for (const [split, name] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
    const path = join(from, name);

    if (!existsSync(path)) {
      return `${path} 가 없어요. 세 분할을 갖춘 데이터 폴더를 주세요.`;
    }

    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "")
      .filter((line) => {
        try {
          return (JSON.parse(line) as { gate?: string }).gate === gate;
        } catch {
          return false;
        }
      });

    rows[split] = lines.length;
    kept[name] = lines;
  }

  const empty = (Object.keys(rows) as DatasetSplit[]).filter((split) => rows[split] === 0);

  if (empty.length > 0) {
    return `${gate}: ${empty.join(", ")} 에 행이 하나도 없어요. 이 게이트는 학습도 보정도 할 수 없어요.`;
  }

  mkdirSync(to, { recursive: true });
  for (const [name, lines] of Object.entries(kept)) {
    writeFileSync(join(to, name), `${lines.join("\n")}\n`);
  }

  return { gate, folder: to, rows };
}

/** The rounds: a node holds one gate at a time, so the gates are dealt out five at a time and each
 * round is run through before the next one starts. */
export function planRounds(gates: readonly string[], nodes: readonly string[]): Array<Array<{ gate: string; node: string }>> {
  if (nodes.length === 0) {
    return [];
  }
  const rounds: Array<Array<{ gate: string; node: string }>> = [];

  for (let at = 0; at < gates.length; at += nodes.length) {
    rounds.push(gates.slice(at, at + nodes.length).map((gate, index) => ({ gate, node: nodes[index]! })));
  }

  return rounds;
}

export function runName(dataset: string, gate: string): string {
  return `${dataset}-${gate}`;
}

export function dataOnNode(dataset: string, gate: string): string {
  return `data/${runName(dataset, gate)}`;
}

export function checkpointOnNode(dataset: string, gate: string): string {
  return `checkpoints/${runName(dataset, gate)}`;
}

export function trainLogOnNode(dataset: string, gate: string): string {
  return `logs/${runName(dataset, gate)}-train.log`;
}

export function calibrateLogOnNode(dataset: string, gate: string): string {
  return `logs/${runName(dataset, gate)}-calibrate.log`;
}

const script = () => `bash ${nodePath(TRAIN_SCRIPT)}`;

export function launchCommand(dataset: string, gate: string, args: readonly string[]): string {
  return [script(), "launch", dataOnNode(dataset, gate), checkpointOnNode(dataset, gate), trainLogOnNode(dataset, gate), ...args].join(" ");
}

export function resumeCommand(dataset: string, gate: string, args: readonly string[]): string {
  return [script(), "resume", checkpointOnNode(dataset, gate), dataOnNode(dataset, gate), trainLogOnNode(dataset, gate), ...args].join(" ");
}

export function calibrateCommand(dataset: string, gate: string, rules: readonly string[] = []): string {
  return [script(), "calibrate", checkpointOnNode(dataset, gate), dataOnNode(dataset, gate),
    calibrateLogOnNode(dataset, gate), ...rules].join(" ");
}

/** What a gate itself says Laya may settle, handed to the measurement as a flag. The declaration
 * belongs to the gate's own specification; nothing here keeps a list of which gates are asymmetric. */
export function asymmetricFlags(gate: string): string[] {
  const declared = synthesisFor(gate);

  if (declared === null) {
    return [];
  }

  return declared.questions
    .filter((question) => question.safe !== undefined)
    .map((question) => `--asymmetric ${gate}:${question.id}:${String(question.safe)}`);
}

export function stateCommand(dataset: string, gate: string): string {
  return [script(), "state", checkpointOnNode(dataset, gate), trainLogOnNode(dataset, gate),
    calibrateLogOnNode(dataset, gate)].join(" ");
}

export function tailCommand(path: string, lines: number): string {
  return `tail -n ${lines} ${nodePath(path)} 2>/dev/null || true`;
}

/** A step's folder name, as the training writes it and the collection reads it. */
export function stepFolder(step: number): string {
  return `step-${String(step).padStart(6, "0")}`;
}

export interface RunState {
  training: boolean;
  calibrating: boolean;
  finished: boolean;
  /** Whether the run's own directory stands at all, which is what tells a run never started from one
   * that was started and left nothing to carry on from. */
  exists: boolean;
  /** Whether a calibration stands that belongs to this training rather than to one that stood here
   * before it. */
  calibrated: boolean;
  step: number | null;
  checkpoints: number;
  lines: number;
  last: string;
}

export function parseRunState(text: string): RunState | null {
  const values = new Map<string, string>();

  for (const line of text.split("\n")) {
    const cut = line.indexOf("=");

    if (cut > 0 && /^[a-z][a-z_]*$/.test(line.slice(0, cut).trim())) {
      values.set(line.slice(0, cut).trim(), line.slice(cut + 1).trim());
    }
  }
  if (!values.has("training") || !values.has("finished")) {
    return null;
  }
  const step = values.get("step") ?? "none";

  return {
    training: values.get("training") === "yes",
    calibrating: values.get("calibrating") === "yes",
    finished: values.get("finished") === "yes",
    exists: values.get("exists") === "yes",
    calibrated: values.get("calibrated") === "yes",
    step: /^step-\d+$/.test(step) ? Number.parseInt(step.slice("step-".length), 10) : null,
    checkpoints: Number.parseInt(values.get("checkpoints") ?? "0", 10) || 0,
    lines: Number.parseInt(values.get("lines") ?? "0", 10) || 0,
    last: values.get("last") ?? "none",
  };
}

export type NextMove = "launch" | "resume" | "wait" | "calibrate" | "collect" | "stuck";

/** What to do with a run, read from its state alone. A run that is not going and has not finished is
 * carried on from its own step checkpoint; one that never wrote a step is started again from the
 * base, since there is nothing to carry on from. */
export function nextMove(state: RunState, uploaded: boolean): NextMove {
  if (state.finished) {
    return state.calibrating ? "wait" : "calibrate";
  }
  if (state.training || state.calibrating) {
    return "wait";
  }
  if (state.step !== null) {
    return "resume";
  }
  // A directory with no step checkpoint in it was started and left nothing to carry on from. The
  // training refuses to write over it and nobody here removes somebody's checkpoint, so it is named.
  if (state.exists) {
    return "stuck";
  }

  return uploaded ? "launch" : "stuck";
}

/** The last whole JSON object a log ends with, which is how a run says what it came to. The scan
 * knows a string from the structure around it, so a brace inside a path or a gate's name does not
 * end the object early. */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inString = false;

    for (let at = end; at >= 0; at -= 1) {
      const letter = text[at]!;

      if (inString) {
        // Walking backwards, a quote ends the string unless the backslashes before it make it part of
        // the text; an odd number of them is what an escape comes to.
        if (letter === '"') {
          let slashes = 0;

          while (at - slashes - 1 >= 0 && text[at - slashes - 1] === "\\") {
            slashes += 1;
          }
          if (slashes % 2 === 0) {
            inString = false;
          }
        }
        continue;
      }
      if (letter === '"') {
        inString = true;
        continue;
      }
      if (letter === "}") {
        depth += 1;
      } else if (letter === "{") {
        depth -= 1;
        if (depth === 0) {
          try {
            const read: unknown = JSON.parse(text.slice(at, end + 1));

            if (typeof read === "object" && read !== null && !Array.isArray(read)) {
              return read as Record<string, unknown>;
            }
          } catch {
            // Not an object after all; try the next closing brace further back.
          }
          break;
        }
      }
    }
  }

  return null;
}

export interface TrainLedgerRow {
  gate: string;
  node: string;
  round: number;
  dataset: string;
  rehearsal: boolean;
  state: "done" | "failed" | "unreachable";
  startedAt: string | null;
  endedAt: string | null;
  steps: number | null;
  epochs: number | null;
  resumes: number;
  seconds: number | null;
  peakReservedBytes: number | null;
  peakAllocatedBytes: number | null;
  microBatch: number | null;
  accumulate: number | null;
  effectiveBatch: number | null;
  precision: string | null;
  device: string | null;
  items: Record<string, number> | null;
  checkpoint: string | null;
  trainLog: string | null;
  calibrateLog: string | null;
  calibration: { agreement: number | null; balanced: number | null; ece: number | null } | null;
  /** The whole machine-readable report the calibration wrote, which the verification table is
   * assembled from. It rides in the ledger so the table needs no second transfer. */
  report: Record<string, unknown> | null;
  /** Where each checkpoint of this run was carried back to, so no step is left only on its node. */
  collected: string[];
  /** Why a checkpoint could not be carried back, where one could not. The training still finished;
   * what is short is the copy, and that is said rather than passed over. */
  collectFault: string | null;
  fault: string | null;
}

export interface TrainLedger {
  run: string;
  dataset: string;
  rehearsal: boolean;
  started: string;
  ended: string;
  nodes: readonly string[];
  rows: TrainLedgerRow[];
}

const numberOr = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const stringOr = (value: unknown): string | null => typeof value === "string" ? value : null;

/** What a finished training said about itself, read into the ledger's own shape. */
export function ledgerFromMeta(meta: Record<string, unknown> | null): Partial<TrainLedgerRow> {
  if (meta === null) {
    return {};
  }
  const accumulate = numberOr(meta.accumulate);
  const microBatch = numberOr(meta.micro_batch);

  return {
    steps: numberOr(meta.steps),
    epochs: Array.isArray(meta.epochs) ? meta.epochs.length : null,
    resumes: numberOr(meta.resumes) ?? 0,
    seconds: numberOr(meta.seconds),
    peakReservedBytes: numberOr(meta.peak_reserved_bytes),
    peakAllocatedBytes: numberOr(meta.peak_allocated_bytes),
    microBatch,
    accumulate,
    effectiveBatch: microBatch !== null && accumulate !== null ? microBatch * accumulate : null,
    precision: stringOr(meta.precision),
    device: stringOr(meta.device),
    items: typeof meta.items === "object" && meta.items !== null ? meta.items as Record<string, number> : null,
  };
}

/** What a calibration came to, as the ledger keeps it. The whole report is the calibration's own to
 * write; what stands here is the three figures a reader of the run wants at a glance. */
/** The machine-readable part of what the calibration printed, where it carries one. */
export function reportOf(printed: Record<string, unknown> | null): Record<string, unknown> | null {
  const held = printed?.report;

  return typeof held === "object" && held !== null && (held as { kind?: string }).kind === "laya-calibration"
    ? held as Record<string, unknown>
    : null;
}

export function ledgerFromReport(report: Record<string, unknown> | null): TrainLedgerRow["calibration"] {
  const after = report?.after;

  if (typeof after !== "object" || after === null) {
    return null;
  }
  const held = after as Record<string, unknown>;

  return { agreement: numberOr(held.agreement), balanced: numberOr(held.balanced), ece: numberOr(held.ece) };
}

export interface DriveOptions {
  runner: NodeRunner;
  console: string;
  dataset: string;
  /** Where the per-gate folders were written on this machine. */
  gateFolders: Record<string, string>;
  rehearsal: boolean;
  args?: readonly string[];
  wait?: (ms: number) => Promise<void>;
  polls?: number;
  everyMs?: number;
  maxResumes?: number;
  /** How a checkpoint is carried off the node. It is handed in rather than reached for, so the driver
   * holds no opinion about where a collection goes. */
  collect?: (ask: CollectAsk) => Promise<{ folder: string } | string>;
  now?: () => Date;
  say?: (line: string) => void;
}

export interface CollectAsk {
  gate: string;
  node: string;
  step: number;
  kind: "final" | "step";
  /** Where it stands on the node, under the account's own folder. */
  source: string;
}

/** One gate trained on one node, from putting its data across to reading what the calibration came
 * to. Everything it decides comes out of the node's own answers, so a run somebody else started, or
 * one this driver started and lost, is picked up rather than begun again. */
export async function driveGate(gate: string, node: string, round: number, options: DriveOptions): Promise<TrainLedgerRow> {
  const now = options.now ?? (() => new Date());
  const say = options.say ?? (() => {});
  const wait = options.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  const polls = options.polls ?? 240;
  const everyMs = options.everyMs ?? 15_000;
  const maxResumes = options.maxResumes ?? 5;
  const args = options.args ?? [];
  const startedAt = now().toISOString();

  const row: TrainLedgerRow = {
    gate, node, round, dataset: options.dataset, rehearsal: options.rehearsal, state: "failed",
    startedAt, endedAt: null, steps: null, epochs: null, resumes: 0, seconds: null,
    peakReservedBytes: null, peakAllocatedBytes: null, microBatch: null, accumulate: null,
    effectiveBatch: null, precision: null, device: null, items: null,
    checkpoint: checkpointOnNode(options.dataset, gate),
    trainLog: trainLogOnNode(options.dataset, gate), calibrateLog: calibrateLogOnNode(options.dataset, gate),
    calibration: null, report: null, collected: [], collectFault: null, fault: null,
  };

  // A checkpoint is carried off the node at the two moments its copy there could become the only one:
  // when a run has died and might not come back, and when a run has finished.
  const carry = async (ask: CollectAsk): Promise<void> => {
    if (options.collect === undefined) {
      return;
    }
    const carried = await options.collect(ask);

    if (typeof carried === "string") {
      row.collectFault = carried;
    } else {
      row.collected.push(carried.folder);
    }
  };
  const ended = (fault: string | null, state: TrainLedgerRow["state"]): TrainLedgerRow =>
    ({ ...row, state, fault, endedAt: now().toISOString() });

  const exec = async (command: string) => options.runner(jakeExecArgs(options.console, node, command));
  const out = (result: RunResult) => (result.stderr || result.stdout).trim().slice(-300);

  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);

  if (home === null) {
    return ended(`노드가 답하지 않아요 — ${out(asked)}`, "unreachable");
  }

  let state = parseRunState((await exec(stateCommand(options.dataset, gate))).stdout);

  if (state === null) {
    return ended("학습 상태를 읽지 못했어요. 노드에 환경이 서 있는지 보세요.", "unreachable");
  }

  // The data goes across once, before the first launch, and never again while the run lives: a
  // resume is bound to the very file it started on, and a file put across a second time would be
  // refused as another run's.
  let uploaded = state.finished || state.training || state.step !== null;

  if (!uploaded) {
    const folder = options.gateFolders[gate];

    if (folder === undefined) {
      return ended(`${gate} 의 데이터 폴더가 없어요.`, "failed");
    }

    await exec(`mkdir -p ${nodePath(dataOnNode(options.dataset, gate))} ${nodePath("logs")}`);
    for (const name of Object.values(splitFiles)) {
      const carried = await options.runner(jakeUploadArgs(
        options.console, node, join(folder, name), `${home}/bmo-laya/${dataOnNode(options.dataset, gate)}/${name}`));

      if (carried.code !== 0) {
        return ended(`${name} 를 올리지 못했어요 — ${out(carried)}`, "failed");
      }
    }
    uploaded = true;
    say(`${node}: ${gate} 데이터를 올렸어요`);
  }

  let calibrating = false;
  let launched = false;

  for (let poll = 0; poll <= polls; poll += 1) {
    const move = nextMove(state, uploaded);

    if (move === "stuck") {
      return ended(state.exists
        ? `${row.checkpoint} 가 있는데 이어 갈 체크포인트가 없어요. 직접 보고 지우세요 — 체크포인트는 우리가 함부로 지우지 않아요.`
        : "올린 데이터도 이어 갈 체크포인트도 없어요.", "failed");
    }
    if (move === "launch" || move === "resume") {
      if (move === "resume") {
        if (row.resumes >= maxResumes) {
          return ended(`${maxResumes}번을 이어 봤는데도 학습이 서지 않아요 — 마지막 줄: ${state.last}`, "failed");
        }
        row.resumes += 1;
        say(`${node}: ${gate} 를 step ${state.step} 에서 이어서 시작해요`);
        await carry({
          gate, node, step: state.step!, kind: "step",
          source: `${checkpointOnNode(options.dataset, gate)}/steps/${stepFolder(state.step!)}`,
        });
      } else {
        // A training started twice from nothing is one that fell over as it started: it left no step
        // to carry on from and no directory to be stuck in, so starting it again would only do the
        // same thing over and over.
        if (launched) {
          return ended(`학습이 시작되자마자 멈췄어요 — 마지막 줄: ${state.last}`, "failed");
        }
        launched = true;
        say(`${node}: ${gate} 학습을 시작해요`);
      }
      const started = await exec(move === "launch"
        ? launchCommand(options.dataset, gate, args)
        : resumeCommand(options.dataset, gate, args));

      if (started.code !== 0) {
        return ended(`학습을 시작하지 못했어요 — ${out(started)}`, "failed");
      }
    }
    if (move === "calibrate") {
      if (!calibrating) {
        // A calibration this training already had is read rather than run again, so a driver started
        // a second time over a finished run costs a reading and nothing else. One left by an earlier
        // run of the same name is not this one's and is not read.
        const said = state.calibrated
          ? lastJsonObject((await exec(tailCommand(calibrateLogOnNode(options.dataset, gate), 800))).stdout)
          : null;
        const standing = ledgerFromReport(said);

        if (standing !== null) {
          const meta = lastJsonObject((await exec(tailCommand(trainLogOnNode(options.dataset, gate), 60))).stdout);

          Object.assign(row, ledgerFromMeta(meta), { calibration: standing, report: reportOf(said) });
          await carry({ gate, node, step: row.steps ?? 0, kind: "final", source: checkpointOnNode(options.dataset, gate) });

          return ended(null, "done");
        }
        say(`${node}: ${gate} 온도 보정을 시작해요`);
        const started = await exec(calibrateCommand(options.dataset, gate, asymmetricFlags(gate)));

        if (started.code !== 0) {
          return ended(`보정을 시작하지 못했어요 — ${out(started)}`, "failed");
        }
        calibrating = true;
      } else {
        // The calibration was started and is not going: it either finished or broke, and its own log
        // is what says which.
        const report = lastJsonObject((await exec(tailCommand(calibrateLogOnNode(options.dataset, gate), 800))).stdout);
        const figures = ledgerFromReport(report);
        const meta = lastJsonObject((await exec(tailCommand(trainLogOnNode(options.dataset, gate), 60))).stdout);

        Object.assign(row, ledgerFromMeta(meta), { calibration: figures, report: reportOf(report) });
        await carry({ gate, node, step: row.steps ?? 0, kind: "final", source: checkpointOnNode(options.dataset, gate) });

        return figures === null
          ? ended("보정이 수치를 남기지 않았어요. 보정 기록을 보세요.", "failed")
          : ended(null, "done");
      }
    }

    await wait(everyMs);
    const read = parseRunState((await exec(stateCommand(options.dataset, gate))).stdout);

    if (read === null) {
      return ended("학습 상태를 읽지 못했어요.", "unreachable");
    }
    state = read;
  }

  return ended(`${Math.round(polls * everyMs / 1000)}초가 지나도 끝나지 않았어요 — 마지막 줄: ${state.last}`, "failed");
}

/** One round: every gate of it at once, one to a node. A node that cannot be reached loses its own
 * gate's round and no other, since each gate's run is its own. */
export async function driveRound(
  pairs: ReadonlyArray<{ gate: string; node: string }>, round: number, options: DriveOptions,
): Promise<TrainLedgerRow[]> {
  return Promise.all(pairs.map((pair) => driveGate(pair.gate, pair.node, round, options)));
}

export async function driveRun(
  gates: readonly string[], nodes: readonly string[], options: DriveOptions,
): Promise<TrainLedger> {
  const now = options.now ?? (() => new Date());
  const started = now().toISOString();
  const rounds = planRounds(gates, nodes);
  const rows: TrainLedgerRow[] = [];

  for (const [index, pairs] of rounds.entries()) {
    options.say?.(`${index + 1}번째 차례: ${pairs.map((one) => `${one.node}→${one.gate}`).join(", ")}`);
    rows.push(...await driveRound(pairs, index + 1, options));
  }

  return {
    run: options.dataset, dataset: options.dataset, rehearsal: options.rehearsal,
    started, ended: now().toISOString(), nodes: [...nodes], rows,
  };
}

export function writeTrainLedger(folder: string, ledger: TrainLedger): string {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, trainLedgerFile);

  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);

  return path;
}

export function readTrainLedger(folder: string): TrainLedger | null {
  const path = join(folder, trainLedgerFile);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const read: unknown = JSON.parse(readFileSync(path, "utf8"));

    return typeof read === "object" && read !== null && Array.isArray((read as TrainLedger).rows) ? read as TrainLedger : null;
  } catch {
    return null;
  }
}

/** Whether the dataset a run was trained on is a rehearsal one. It is read from the folder rather
 * than taken on trust, and it rides in the ledger so every table made from it says so. */
export function datasetIsRehearsal(folder: string): boolean {
  return rehearsalFolder(folder);
}

const gb = (bytes: number | null): string => bytes === null ? "—" : `${(bytes / 1e9).toFixed(2)} GB`;

/** The per-node table: what each gate's run took on the node that ran it (instruction 9). */
export function trainLedgerLines(ledger: TrainLedger): string[] {
  const head = ["실험", "게이트", "노드", "차례", "상태", "스텝", "이어감", "걸린 시간", "VRAM 최대", "배치", "정밀도"];
  const body = ledger.rows.map((row) => [
    runWord(row.rehearsal),
    row.gate,
    row.node,
    String(row.round),
    row.state === "done" ? "끝남" : row.state === "unreachable" ? "닿지 않음" : "실패",
    row.steps === null ? "—" : String(row.steps),
    String(row.resumes),
    row.seconds === null ? "—" : `${Math.round(row.seconds)}초`,
    gb(row.peakReservedBytes),
    row.microBatch === null ? "—" : `${row.microBatch}×${row.accumulate ?? "?"}=${row.effectiveBatch ?? "?"}`,
    row.precision ?? "—",
  ]);
  const widths = head.map((_, column) => Math.max(...[head, ...body].map((line) => printedWidth(line[column] ?? ""))));
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column]! - printedWidth(cell)))).join("  ").trimEnd();
  const notes = ledger.rows.filter((row) => row.fault !== null).map((row) => `${row.gate} (${row.node}): ${row.fault}`);

  return [
    ...ledger.rehearsal ? ["리허설 데이터로 학습한 것이라 여기 수치는 기계가 제대로 실행되는지만 말해요."] : [],
    line(head),
    line(widths.map((width) => "-".repeat(width))),
    ...body.map(line),
    ...notes.length > 0 ? ["", ...notes] : [],
  ];
}
