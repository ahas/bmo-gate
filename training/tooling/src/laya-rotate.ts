import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { claimsIn, writerAlive } from "./gate-claim";
import { collectedFolders, collectionRoot } from "./laya-collect";
import { layaHealth, servedCheckpoints } from "./laya-service";
import { LAYA_SERVICE_PLACEMENT } from "./llm-install";
import { PlacementRefused, readPlacement } from "./placement";
import { dataPath } from "./roots";
import { ledgerFile } from "./train/ledger";

import type { CheckpointManifest } from "./laya-collect";
import type { ServiceNode } from "./llm-install";

// The collection rotated around what the service answers with (docs/training.md, 「Rotating the
// collection」): a training gate's folder keeps the checkpoints served now, the ones each gate was
// served by just before, what a pass still running has carried back, and the newest finished one
// waiting for the owner's decision. Everything else goes. What is served is read from the service at every
// rotation and never remembered here, and a service that cannot say stops the rotation outright.

export const ROTATION_FILE = "rotation.json";
export const SERVED_FILE = "served.jsonl";
const ROTATION_SHAPE = '{"deployed": <1 or more>, "candidates": <0 or more>}';
const SERVED_PREFIX = "checkpoints/";

export interface RotationSettings {
  /** How many checkpoints a served gate keeps of those it was last served by, the one serving it now first. */
  deployed: number;
  /** How many finished checkpoints newer than what its folder serves a training gate keeps for a decision. */
  candidates: number;
}

export const ROTATION_DEFAULTS: RotationSettings = { deployed: 2, candidates: 1 };

/** The settings in the collection's root, the defaults where there are none, or why they cannot be read. */
export function readRotation(root: string): RotationSettings | string {
  const path = join(root, ROTATION_FILE);

  if (!existsSync(path)) {
    return ROTATION_DEFAULTS;
  }

  let read: unknown;
  try {
    read = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    return `${path} is not JSON (${cause instanceof Error ? cause.message : String(cause)}); write it in this shape: ${ROTATION_SHAPE}`;
  }

  const given = typeof read === "object" && read !== null && !Array.isArray(read) ? read as Record<string, unknown> : null;
  const deployed = given?.deployed ?? ROTATION_DEFAULTS.deployed;
  const candidates = given?.candidates ?? ROTATION_DEFAULTS.candidates;

  if (given === null || !Number.isInteger(deployed) || (deployed as number) < 1 || !Number.isInteger(candidates) || (candidates as number) < 0) {
    return `${path} could not be read; write it in this shape: ${ROTATION_SHAPE}`;
  }

  return { deployed: deployed as number, candidates: candidates as number };
}

/** A gate as the gate asks it, answered by a checkpoint named as the collection lays it out. */
export interface ServedPair {
  gate: string;
  checkpoint: string;
}

export interface ServedLine extends ServedPair {
  at: string;
}

/** The serving record, oldest first. A line that cannot be read is no line. */
export function readServed(root: string): ServedLine[] {
  const path = join(root, SERVED_FILE);

  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      const one = JSON.parse(line) as Partial<ServedLine>;

      return typeof one.gate === "string" && typeof one.checkpoint === "string" && typeof one.at === "string"
        ? [{ gate: one.gate, checkpoint: one.checkpoint, at: one.at }]
        : [];
    } catch {
      return [];
    }
  });
}

/** Each served pair the record does not already name as its gate's latest, appended, and the record as
 * it stands after. */
export function noteServed(root: string, served: readonly ServedPair[], now: Date): ServedLine[] {
  const record = readServed(root);
  const latest = new Map(record.map((line) => [line.gate, line.checkpoint]));
  const added = served
    .filter((pair) => latest.get(pair.gate) !== pair.checkpoint)
    .map((pair): ServedLine => ({ gate: pair.gate, checkpoint: pair.checkpoint, at: now.toISOString() }));

  if (added.length > 0) {
    appendFileSync(join(root, SERVED_FILE), added.map((line) => `${JSON.stringify(line)}\n`).join(""));
  }

  return [...record, ...added];
}

export type KeepReason = "served" | "deployed" | "training" | "candidate";

export interface Standing {
  /** `<training gate>/<run>/step-<n>`, relative to the collection's root. */
  checkpoint: string;
  manifest: CheckpointManifest;
}

export interface RotationPlan {
  keep: (Standing & { why: KeepReason })[];
  drop: Standing[];
}

export interface PlanAsk {
  standing: readonly Standing[];
  served: readonly ServedPair[];
  record: readonly ServedLine[];
  /** Whether a run's pass is still training. */
  training: (run: string) => boolean;
  settings: RotationSettings;
}

/** Which checkpoints stay and why, and which go. Pure, so the rule is read off one place. */
export function rotationPlan(ask: PlanAsk): RotationPlan {
  const why = new Map<string, KeepReason>();
  const mark = (checkpoint: string, reason: KeepReason) => {
    if (!why.has(checkpoint)) {
      why.set(checkpoint, reason);
    }
  };

  for (const pair of ask.served) {
    mark(pair.checkpoint, "served");
  }

  // Each gate's last few, the one serving it now first and then the record newest first.
  for (const gate of new Set([...ask.served.map((pair) => pair.gate), ...ask.record.map((line) => line.gate)])) {
    const order = [
      ...ask.served.filter((pair) => pair.gate === gate).map((pair) => pair.checkpoint),
      ...ask.record.filter((line) => line.gate === gate).map((line) => line.checkpoint).reverse(),
    ];

    for (const checkpoint of [...new Set(order)].slice(0, ask.settings.deployed)) {
      mark(checkpoint, "deployed");
    }
  }

  for (const one of ask.standing.filter((standing) => ask.training(standing.manifest.run))) {
    mark(one.checkpoint, "training");
  }

  // The newest finished real checkpoints of each training gate's folder collected after the newest one
  // served from it.
  for (const gate of new Set(ask.standing.map((one) => trainingGate(one.checkpoint)))) {
    const own = ask.standing.filter((one) => trainingGate(one.checkpoint) === gate);
    const servedAt = own
      .filter((one) => ask.served.some((pair) => pair.checkpoint === one.checkpoint))
      .map((one) => one.manifest.collected)
      .sort()
      .at(-1) ?? "";
    const waiting = own
      .filter((one) => one.manifest.checkpoint === "final" && !one.manifest.rehearsal && one.manifest.collected > servedAt && !why.has(one.checkpoint))
      .sort((a, b) => b.manifest.collected.localeCompare(a.manifest.collected));

    for (const one of waiting.slice(0, ask.settings.candidates)) {
      mark(one.checkpoint, "candidate");
    }
  }

  return {
    keep: ask.standing.flatMap((one) => {
      const reason = why.get(one.checkpoint);

      return reason === undefined ? [] : [{ ...one, why: reason }];
    }),
    drop: ask.standing.filter((one) => !why.has(one.checkpoint)),
  };
}

function trainingGate(checkpoint: string): string {
  return checkpoint.split("/")[0]!;
}

/** Whether the pass a run is named for is still training: no ledger written yet, and the curve of the
 * source it is a pass of claimed by a living process. A run named for no pass is never training. */
export function passTraining(
  run: string,
  where: { runs: string; curves: string; alive?: (pid: number) => boolean } = { runs: dataPath("laya-runs"), curves: dataPath("laya-curve") },
): boolean {
  const source = /^(.+)-p\d{4}$/.exec(run)?.[1];

  if (source === undefined || existsSync(join(where.runs, run, ledgerFile))) {
    return false;
  }

  return claimsIn(join(where.curves, source)).some((claim) => (where.alive ?? writerAlive)(claim.pid));
}

/** What the service's nodes serve now, each asked at its own listen, or which node did not say. */
export async function servedNow(
  nodes: readonly ServiceNode[],
  health: (url: string) => Promise<Record<string, unknown> | null> = layaHealth,
): Promise<ServedPair[] | string> {
  const pairs: ServedPair[] = [];

  for (const at of nodes) {
    const said = await health(`http://${at.listen}`);

    if (said === null) {
      return `${at.node} (${at.listen}) does not answer health, so what it serves is not known`;
    }
    for (const [gate, model] of servedCheckpoints(said)) {
      const checkpoint = model.startsWith(SERVED_PREFIX) ? model.slice(SERVED_PREFIX.length) : model;

      if (!pairs.some((pair) => pair.gate === gate && pair.checkpoint === checkpoint)) {
        pairs.push({ gate, checkpoint });
      }
    }
  }

  return pairs;
}

/** What the nodes of the service's placement serve now, or why that cannot be read. */
export async function servedByPlacement(): Promise<ServedPair[] | string> {
  try {
    return await servedNow(readPlacement(LAYA_SERVICE_PLACEMENT));
  } catch (cause) {
    if (cause instanceof PlacementRefused) {
      return cause.message;
    }
    throw cause;
  }
}

export interface RotateAsk {
  /** What is served now, or why it cannot be known. */
  served: () => Promise<ServedPair[] | string>;
  root?: string;
  training?: (run: string) => boolean;
  dryRun?: boolean;
  now?: () => Date;
}

export interface Rotation {
  plan: RotationPlan;
  /** The bytes of what went, or would go on a dry run, by the manifests. */
  freed: number;
}

/** One rotation of the collection: the record brought up to what is served, the plan made, and what it
 * drops removed with every run folder left empty. Nothing is removed where anything could not be read. */
export async function rotateCollection(ask: RotateAsk): Promise<Rotation | string> {
  const root = ask.root ?? collectionRoot();
  const settings = readRotation(root);

  if (typeof settings === "string") {
    return settings;
  }

  const served = await ask.served();

  if (typeof served === "string") {
    return `${served}; nothing was removed`;
  }

  const standing = collectedFolders(root).map((one) => ({ checkpoint: relative(root, one.folder), manifest: one.manifest }));
  const record = ask.dryRun === true ? readServed(root) : noteServed(root, served, (ask.now ?? (() => new Date()))());
  const plan = rotationPlan({ standing, served, record, training: ask.training ?? ((run) => passTraining(run)), settings });

  if (ask.dryRun !== true) {
    for (const one of plan.drop) {
      const folder = join(root, one.checkpoint);

      rmSync(folder, { recursive: true, force: true });
      if (readdirSync(dirname(folder)).length === 0) {
        rmSync(dirname(folder), { recursive: true, force: true });
      }
    }
  }

  return { plan, freed: plan.drop.reduce((sum, one) => sum + one.manifest.bytes, 0) };
}

const REASONS: Record<KeepReason, string> = { served: "served", deployed: "deployed before", training: "training", candidate: "candidate" };

/** What a rotation kept and why, and what it let go, gate by gate. */
export function rotationLines(rotation: Rotation, dryRun: boolean): string[] {
  const gates = [...new Set([...rotation.plan.keep, ...rotation.plan.drop].map((one) => trainingGate(one.checkpoint)))].sort();
  const lines = gates.map((gate) => {
    const kept = rotation.plan.keep.filter((one) => trainingGate(one.checkpoint) === gate);
    const dropped = rotation.plan.drop.filter((one) => trainingGate(one.checkpoint) === gate).length;

    return `${gate}: ${kept.length === 0 ? "nothing kept" : kept.map((one) => `${one.checkpoint.slice(gate.length + 1)} (${REASONS[one.why]})`).join(", ")} · ${dropped} ${dryRun ? "to remove" : "removed"}`;
  });

  return [...lines, `${rotation.plan.drop.length} checkpoints ${dryRun ? "to remove" : "removed"}, ${(rotation.freed / 1e9).toFixed(1)}GB`];
}
