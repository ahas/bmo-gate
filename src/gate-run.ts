import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { frozenHere } from "./laya-frozen";
import { gateFolder, gatesFolderName } from "./roots";
import { gateOnDisk, guardFolder, plannedBatches, readProgress, runSynthesis } from "./laya-synth-run";

import type { SplitShares } from "./laya-dataset";
import type { GateSynthesis } from "./laya-synth";
import type { SynthAsker, SynthMeta, SynthRoad, TokenTally } from "./laya-synth-run";

// Ten gates at once, one thread and one folder each (docs/gate-data.md 「A run」). The gates are
// run beside each other rather than one after another because they share nothing: no gate reads
// or writes another's batches, another's progress or another's thread, so the only thing they
// contend for is the account, and the account holds ten.
//
// What one gate does is the generation's own, unchanged. What is added here is that there are ten
// of them, that one falling over costs only itself, and that the whole thing can be left running
// and read from outside.

export interface DriveOptions {
  // The run's folder. Every gate's folder stands under it, and so does the merged dataset.
  root: string;
  gates: readonly GateSynthesis[];
  rows: number;
  batchSize: number;
  model: string;
  effort: string;
  // The road these gates are driven on. The asker must be the one that speaks it: the driver hands
  // in both, and this is what a gate's own progress and meta record. Codex unless a run says
  // otherwise, which is what sanitizer's own run does when it moves off codex onto J3090.
  road?: SynthRoad;
  shares: SplitShares;
  // How many gates write at the same time. All of them, unless a reason is given to hold back.
  atOnce: number;
  resume: boolean;
  overwrite: boolean;
  say?: (line: string) => void;
}

export type GateState =
  // Written and frozen by this run.
  | "done"
  // Already frozen before this run, and left exactly as it stands.
  | "stands"
  // Not written, because the folder is not this run's to write.
  | "refused"
  // Started and fell over. What it had frozen stands, and it can be taken up again.
  | "failed";

export interface GateOutcome {
  gate: string;
  state: GateState;
  // The guard's own words, on a gate that was refused.
  refusal: string | null;
  // What went wrong, on a gate that fell over.
  fault: string | null;
  meta: SynthMeta | null;
}

// Several at a time, with one lane picking up the next gate as soon as it is free. A gate that
// throws does not take the lane down with it, because every gate is caught where it runs.
async function inLanes<T>(items: readonly T[], atOnce: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const howMany = Math.max(1, Math.min(atOnce, items.length));

  await Promise.all(Array.from({ length: howMany }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await work(next);
    }
  }));
}

// Starting a gate over means starting it over. What stands in its folder belongs to the run being
// replaced, and a batch of that run left behind would be read back at freezing time and land in
// the new dataset — so a gate rebuilt because it missed its bars would carry the very rows that
// missed them. Only ever reached when the run said outright that it meant to overwrite.
export function clearGate(root: string, folder: string): void {
  if (!folder.startsWith(`${join(root, gatesFolderName)}/`)) {
    throw new Error(`${folder} 는 이 실행의 게이트 폴더가 아닙니다.`);
  }

  rmSync(folder, { recursive: true, force: true });
}

export async function driveGates(options: DriveOptions, ask: SynthAsker): Promise<GateOutcome[]> {
  const say = options.say ?? (() => {});
  const outcomes = new Map<string, GateOutcome>();

  mkdirSync(join(options.root, gatesFolderName), { recursive: true });

  await inLanes(options.gates, options.atOnce, async (spec) => {
    const folder = gateFolder(options.root, spec.gate);

    // A gate that is already frozen is a gate already written. A run taking up where it left off
    // leaves it alone rather than refusing over it: nine finished gates are not nine errors, they
    // are the reason there is anything to take up.
    if (options.resume && !options.overwrite && frozenHere(folder)) {
      outcomes.set(spec.gate, { gate: spec.gate, state: "stands", refusal: null, fault: null, meta: null });
      say(`${spec.gate}: 이미 굳어 있습니다. 그대로 둡니다.`);

      return;
    }

    const refusal = guardFolder(folder, { resume: options.resume, overwrite: options.overwrite });

    if (refusal !== null) {
      outcomes.set(spec.gate, { gate: spec.gate, state: "refused", refusal, fault: null, meta: null });
      say(`${spec.gate}: ${refusal}`);

      return;
    }

    if (options.overwrite && existsSync(folder)) {
      clearGate(options.root, folder);
      say(`${spec.gate}: 있던 것을 지우고 처음부터 씁니다.`);
    }

    try {
      const report = await runSynthesis({
        folder,
        gates: [spec],
        rows: options.rows,
        batchSize: options.batchSize,
        model: options.model,
        effort: options.effort,
        road: options.road ?? "codex",
        shares: options.shares,
        resume: options.resume,
        say,
      }, ask);

      outcomes.set(spec.gate, { gate: spec.gate, state: "done", refusal: null, fault: null, meta: report.meta });
    } catch (trouble) {
      // One gate falling over is one gate. The other nine keep writing, and what this one had
      // frozen stands and is taken up again later.
      const fault = trouble instanceof Error ? trouble.message : String(trouble);

      outcomes.set(spec.gate, { gate: spec.gate, state: "failed", refusal: null, fault, meta: null });
      say(`${spec.gate}: 멈췄습니다 — ${fault}`);
    }
  });

  return options.gates.map((spec) => outcomes.get(spec.gate)!);
}

export type GateStandingState = "not started" | "running" | "frozen";

export interface GateStanding {
  gate: string;
  state: GateStandingState;
  done: number;
  planned: number;
  kept: number;
  lostBatches: number;
  refused: Record<string, number>;
  tokens: TokenTally;
  // Whether the gate is riding a thread, which is what says the fixed prefix is being read from
  // the cache rather than sent again.
  threadHeld: boolean;
}

// How far a run got, read out of the folders while it is still going. Nothing here attaches to a
// running driver or asks it anything: a gate writes its progress after every batch, so the folder
// is the account of it and can be read by anybody at any time.
//
// The batches standing on disk settle `done` and `kept`, the same way a resumed run settles them.
// A count written after a batch and a batch written before its count are a moment apart, and the
// batch is the one that is true.
export function readRunStanding(root: string, gates: readonly GateSynthesis[]): GateStanding[] {
  return gates.map((spec) => {
    const folder = gateFolder(root, spec.gate);
    const progress = readProgress(folder);

    if (progress === null) {
      return {
        gate: spec.gate,
        state: "not started" as const,
        done: 0,
        planned: 0,
        kept: 0,
        lostBatches: 0,
        refused: {},
        tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        threadHeld: false,
      };
    }

    const held = progress.gates[spec.gate];
    const planned = plannedBatches(spec, progress.rows, progress.batchSize).length;
    const stands = gateOnDisk(folder, spec.gate, planned);

    return {
      gate: spec.gate,
      state: frozenHere(folder) ? ("frozen" as const) : ("running" as const),
      done: stands.done,
      planned,
      kept: stands.kept,
      lostBatches: stands.lost,
      refused: held?.refused ?? {},
      tokens: held?.tokens ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      threadHeld: held?.sessionId != null,
    };
  });
}

const standingWords: Record<GateStandingState, string> = {
  "not started": "아직",
  running: "쓰는 중",
  frozen: "굳음",
};

export function standingLines(standing: readonly GateStanding[]): string[] {
  const lines = standing.map((one) => {
    const refused = Object.entries(one.refused).sort(([a], [b]) => a.localeCompare(b))
      .map(([why, count]) => `${why} ${count}`).join(", ");

    return [
      `${one.gate}: ${standingWords[one.state]}`,
      `묶음 ${one.done}/${one.planned}`,
      `행 ${one.kept}`,
      `날린 묶음 ${one.lostBatches}`,
      `버린 행 ${refused === "" ? "없음" : refused}`,
      `캐시읽기 ${one.tokens.cacheReadTokens} 새 입력 ${one.tokens.inputTokens}`,
      one.threadHeld ? "실 붙듦" : "실 없음",
    ].join(" · ");
  });

  const done = standing.reduce((all, one) => all + one.done, 0);
  const planned = standing.reduce((all, one) => all + one.planned, 0);
  const kept = standing.reduce((all, one) => all + one.kept, 0);

  return [...lines, "", `모두 ${standing.length}게이트 · 묶음 ${done}/${planned} · 행 ${kept}`];
}
