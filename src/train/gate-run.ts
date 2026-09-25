import { join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault } from "../jake";
import { splitFiles } from "../laya-frozen";
import { nodePath, readCard } from "../laya-nodes";
import { synthesisFor } from "../laya-synth";

import type { NodeRunner } from "../jake";
import type { LedgerRow } from "./ledger";

// One gate on one node (docs/training.md, 「One gate on one node」): its data put across once, the
// training started detached, watched while it moves, carried on from its newest step when it dies,
// calibrated beside the checkpoint it is measured against, and its checkpoint carried back. The shell
// of a run is the committed `node-train.sh`; what is here composes the calls, reads what comes back
// and decides the next move out of the node's own answers, so a run somebody else started, or one a
// pass lost, is picked up rather than begun again.

export const TRAIN_SCRIPT = "node-train.sh";
// Where a checkpoint measured beside a gate is put on a training node, under the account's home.
export const BESIDE_DIR = "bmo-laya/beside";

export function runName(pass: string, gate: string): string {
  return `${pass}-${gate}`;
}

export function dataOnNode(pass: string, gate: string): string {
  return `data/${runName(pass, gate)}`;
}

export function checkpointOnNode(pass: string, gate: string): string {
  return `checkpoints/${runName(pass, gate)}`;
}

export function trainLogOnNode(pass: string, gate: string): string {
  return `logs/${runName(pass, gate)}-train.log`;
}

export function calibrateLogOnNode(pass: string, gate: string): string {
  return `logs/${runName(pass, gate)}-calibrate.log`;
}

const script = () => `bash ${nodePath(TRAIN_SCRIPT)}`;

export function launchCommand(pass: string, gate: string, args: readonly string[]): string {
  return [script(), "launch", dataOnNode(pass, gate), checkpointOnNode(pass, gate), trainLogOnNode(pass, gate), ...args].join(" ");
}

export function resumeCommand(pass: string, gate: string, args: readonly string[]): string {
  return [script(), "resume", checkpointOnNode(pass, gate), dataOnNode(pass, gate), trainLogOnNode(pass, gate), ...args].join(" ");
}

export function calibrateCommand(pass: string, gate: string, flags: readonly string[] = []): string {
  return [script(), "calibrate", checkpointOnNode(pass, gate), dataOnNode(pass, gate), calibrateLogOnNode(pass, gate), ...flags].join(" ");
}

export function stateCommand(pass: string, gate: string): string {
  return [script(), "state", checkpointOnNode(pass, gate), trainLogOnNode(pass, gate), calibrateLogOnNode(pass, gate)].join(" ");
}

export function tailCommand(path: string, lines: number): string {
  return `tail -n ${lines} ${nodePath(path)} 2>/dev/null || true`;
}

/** What a gate itself says Laya may settle, handed to the measurement as a flag. The declaration
 * belongs to the gate's own specification; nothing here keeps a list of which gates are asymmetric. */
export function asymmetricFlags(gate: string): string[] {
  const declared = synthesisFor(gate);

  return declared === null
    ? []
    : declared.questions.filter((question) => question.safe !== undefined).map((question) => `--asymmetric ${gate}:${question.id}:${String(question.safe)}`);
}

/** A step's folder name, as the training writes it and the collection reads it. */
export function stepFolder(step: number): string {
  return `step-${String(step).padStart(6, "0")}`;
}

export interface RunState {
  training: boolean;
  calibrating: boolean;
  finished: boolean;
  // Whether the run's own directory stands at all, which tells a run never started from one that was
  // started and left nothing to carry on from.
  exists: boolean;
  // Whether a calibration stands that belongs to this training rather than to one before it.
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

export type NextMove = "launch" | "resume" | "wait" | "calibrate" | "stuck";

/** What to do with a run, read from its state alone. A run not going and not finished is carried on
 * from its own step checkpoint; one that never wrote a step is started from the base, since there is
 * nothing to carry on from; one whose directory stands with no step in it is named, since nobody here
 * removes somebody's checkpoint. */
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

  if (state.exists) {
    return "stuck";
  }

  return uploaded ? "launch" : "stuck";
}

/** The last whole JSON object a log ends with, which is how a run says what it came to. The scan
 * knows a string from the structure around it, so a brace inside a path does not end it early. */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inString = false;

    for (let at = end; at >= 0; at -= 1) {
      const letter = text[at]!;

      if (inString) {
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
            // Not an object after all; the next closing brace further back is tried.
          }

          break;
        }
      }
    }
  }

  return null;
}

const numberOr = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const stringOr = (value: unknown): string | null => typeof value === "string" ? value : null;

/** What a finished training said about itself, read into the ledger's own shape. */
export function ledgerFromMeta(meta: Record<string, unknown> | null): Partial<LedgerRow> {
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
  };
}

/** The machine-readable part of what the calibration printed, where it carries one. */
export function reportOf(printed: Record<string, unknown> | null): Record<string, unknown> | null {
  const held = printed?.report;

  return typeof held === "object" && held !== null && (held as { kind?: string }).kind === "laya-calibration"
    ? held as Record<string, unknown>
    : null;
}

/** The three figures a reader of the pass wants at a glance, out of what the calibration printed. */
export function calibrationOf(printed: Record<string, unknown> | null): LedgerRow["calibration"] {
  const after = printed?.after;

  if (typeof after !== "object" || after === null) {
    return null;
  }

  const held = after as Record<string, unknown>;

  return { agreement: numberOr(held.agreement), balanced: numberOr(held.balanced), ece: numberOr(held.ece) };
}

export interface CollectAsk {
  gate: string;
  node: string;
  step: number;
  kind: "final" | "step";
  // Where it stands on the node, under the account's own folder.
  source: string;
}

export interface GateRunOptions {
  runner: NodeRunner;
  console: string;
  pass: string;
  rehearsal: boolean;
  // The gate's copied rows on this machine.
  folder: string;
  // The checkpoint measured beside it, `<gate>/<run>/step-<n>` in the collection, or null for the one
  // it was trained from.
  beside: string | null;
  // Puts the beside checkpoint on the node under BESIDE_DIR, or says why it could not.
  carryBeside: (node: string, checkpoint: string) => Promise<string | null>;
  collect: (ask: CollectAsk) => Promise<{ folder: string } | string>;
  args?: readonly string[];
  wait?: (ms: number) => Promise<void>;
  polls?: number;
  everyMs?: number;
  maxResumes?: number;
  now?: () => Date;
  say?: (line: string) => void;
}

export function unfinishedRow(gate: string, node: string, round: number, options: Pick<GateRunOptions, "pass" | "rehearsal" | "beside">, startedAt: string | null): LedgerRow {
  return {
    gate, node, round, pass: options.pass, rehearsal: options.rehearsal, state: "failed",
    startedAt, endedAt: null, steps: null, epochs: null, resumes: 0, seconds: null,
    peakReservedBytes: null, peakAllocatedBytes: null, microBatch: null, accumulate: null, effectiveBatch: null,
    precision: null, device: null,
    checkpoint: checkpointOnNode(options.pass, gate),
    trainLog: trainLogOnNode(options.pass, gate), calibrateLog: calibrateLogOnNode(options.pass, gate),
    beside: options.beside, calibration: null, report: null, collected: [], collectFault: null, fault: null,
  };
}

export async function runGate(gate: string, node: string, round: number, options: GateRunOptions): Promise<LedgerRow> {
  const now = options.now ?? (() => new Date());
  const say = options.say ?? (() => {});
  const wait = options.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  const polls = options.polls ?? 240;
  const everyMs = options.everyMs ?? 15_000;
  const maxResumes = options.maxResumes ?? 5;
  const args = options.args ?? [];
  const pass = options.pass;
  const row = unfinishedRow(gate, node, round, options, now().toISOString());

  const carry = async (ask: CollectAsk): Promise<void> => {
    const carried = await options.collect(ask);

    if (typeof carried === "string") {
      row.collectFault = carried;
    } else {
      row.collected.push(carried.folder);
    }
  };
  const ended = (fault: string | null, state: LedgerRow["state"]): LedgerRow => ({ ...row, state, fault, endedAt: now().toISOString() });
  const { exec, upload } = nodeCalls(options.runner, options.console, node);
  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);

  if (home === null) {
    return ended(`노드가 답하지 않아요 — ${runFault(asked)}`, "unreachable");
  }

  const stated = await exec(stateCommand(pass, gate));
  let state = parseRunState(stated.stdout);

  if (state === null) {
    return ended(`학습 상태를 읽지 못했어요 — ${runFault(stated)}. 노드에 환경이 서 있는지 보세요.`, "unreachable");
  }

  // The data goes across once, before the first launch, and never again while the run lives.
  let uploaded = state.finished || state.training || state.step !== null;

  if (!uploaded) {
    await exec(`mkdir -p ${nodePath(dataOnNode(pass, gate))} ${nodePath("logs")}`);

    for (const name of Object.values(splitFiles)) {
      const carried = await upload(join(options.folder, name), `${home}/bmo-laya/${dataOnNode(pass, gate)}/${name}`);

      if (carried.code !== 0) {
        return ended(`${name} 를 올리지 못했어요 — ${runFault(carried)}`, "failed");
      }
    }

    uploaded = true;
    say(`${node}: ${gate} 데이터를 올렸어요`);
  }

  // What the calibration measures the new checkpoint beside: the one serving the gate, put on the node
  // first, or the one it was trained from where that cannot be had.
  const calibrationFlags = async (): Promise<string[]> => {
    if (options.beside === null) {
      return asymmetricFlags(gate);
    }

    const fault = await options.carryBeside(node, options.beside);

    if (fault !== null) {
      say(`${node}: ${gate} 를 ${options.beside} 옆에서 재지 못해 학습 출발점 옆에서 재요 — ${fault}`);
      row.beside = null;

      return asymmetricFlags(gate);
    }

    return [...asymmetricFlags(gate), `--base ${nodePath("beside", "checkpoints", options.beside)}`];
  };

  let calibrating = false;
  let launched = false;
  // Why the card could not be started on at the last reading, or null where it could.
  let held: string | null = null;

  // A run is waited on while it moves, however long that is, and given up on once nothing about it
  // has moved for the whole bound.
  for (let still = 0; still <= polls;) {
    const move = nextMove(state, uploaded);

    if (move === "stuck") {
      return ended(state.exists
        ? `${row.checkpoint} 가 있는데 이어 갈 체크포인트가 없어요. 직접 보고 지우세요 — 체크포인트는 우리가 함부로 지우지 않아요.`
        : "올린 데이터도 이어 갈 체크포인트도 없어요.", "failed");
    }

    // The card stands free between this gate's own processes, and another training can take it in that
    // gap, so it is read again right before anything is started on it. A taken card is a run that does
    // not move, and the bound below is what gives up on it.
    const starts = move === "launch" || move === "resume" || (move === "calibrate" && !calibrating && !state.calibrated);
    const card = starts ? await readCard(node, options.runner, options.console) : null;

    if (card?.state === "silent") {
      return ended(card.why, "unreachable");
    }

    if (card?.state === "taken" && held === null) {
      say(`${node}: ${gate} 를 올릴 카드가 차 있어 비기를 기다려요 — ${card.why}`);
    }

    held = card?.state === "taken" ? card.why : null;

    if (held === null && (move === "launch" || move === "resume")) {
      if (move === "resume") {
        if (row.resumes >= maxResumes) {
          return ended(`${maxResumes}번을 이어 봤는데도 학습이 서지 않아요 — 마지막 줄: ${state.last}`, "failed");
        }

        row.resumes += 1;
        say(`${node}: ${gate} 를 step ${state.step} 에서 이어서 시작해요`);
        await carry({ gate, node, step: state.step!, kind: "step", source: `${checkpointOnNode(pass, gate)}/steps/${stepFolder(state.step!)}` });
      } else {
        // A training started twice from nothing fell over as it started; starting it a third time
        // would only do the same.
        if (launched) {
          return ended(`학습이 시작되자마자 멈췄어요 — 마지막 줄: ${state.last}`, "failed");
        }

        launched = true;
        say(`${node}: ${gate} 학습을 시작해요`);
      }

      const started = await exec(move === "launch" ? launchCommand(pass, gate, args) : resumeCommand(pass, gate, args));

      if (started.code !== 0) {
        return ended(`학습을 시작하지 못했어요 — ${runFault(started)}`, "failed");
      }
    }

    if (held === null && move === "calibrate") {
      if (!calibrating && !state.calibrated) {
        say(`${node}: ${gate} 온도 보정을 시작해요`);

        const started = await exec(calibrateCommand(pass, gate, await calibrationFlags()));

        if (started.code !== 0) {
          return ended(`보정을 시작하지 못했어요 — ${runFault(started)}`, "failed");
        }

        calibrating = true;
      } else {
        // The calibration is not going: it finished or broke, and its own log says which. One this
        // training already had is read rather than run again.
        const printed = lastJsonObject((await exec(tailCommand(calibrateLogOnNode(pass, gate), 800))).stdout);
        const meta = lastJsonObject((await exec(tailCommand(trainLogOnNode(pass, gate), 60))).stdout);
        const calibration = calibrationOf(printed);

        Object.assign(row, ledgerFromMeta(meta), { calibration, report: reportOf(printed) });
        await carry({ gate, node, step: row.steps ?? 0, kind: "final", source: checkpointOnNode(pass, gate) });

        return calibration === null ? ended("보정이 수치를 남기지 않았어요. 보정 기록을 보세요.", "failed") : ended(null, "done");
      }
    }

    await wait(everyMs);

    const reread = await exec(stateCommand(pass, gate));
    const read = parseRunState(reread.stdout);

    if (read === null) {
      return ended(`학습 상태를 읽지 못했어요 — ${runFault(reread)}`, "unreachable");
    }

    const moved = read.lines !== state.lines || read.step !== state.step || read.training !== state.training
      || read.calibrating !== state.calibrating || read.finished !== state.finished;

    still = moved ? 0 : still + 1;
    state = read;
  }

  return ended(held !== null
    ? `${Math.round(polls * everyMs / 1000)}초 동안 카드가 비지 않았어요 — ${held}`
    : `${Math.round(polls * everyMs / 1000)}초 동안 아무것도 움직이지 않았어요 — 마지막 줄: ${state.last}`, "failed");
}
