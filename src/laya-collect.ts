import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault } from "./jake";
import { nodePath, notTrainingNodes } from "./laya-nodes";
import { workbenchPath } from "./roots";

import type { NodeRunner } from "./jake";

// A checkpoint carried off the node that made it (docs/laya-train-run.md, 「Checkpoint naming and
// collection」). A node that dies must not be the only copy of a step, and a checkpoint is a folder
// while the transfer carries a file, so it travels as one tar and is unpacked here.
//
// What is collected is named for the gate, the run and the step, so which is which can be read from
// the name alone, and a manifest beside it says where it came from and whether the run that made it
// was a rehearsal.

export const COLLECT_SCRIPT = "node-collect.sh";
export const manifestFile = "manifest.json";
export const MANIFEST_KIND = "laya-checkpoint";
export const PARTIAL_SUFFIX = ".partial";

export type CheckpointKind = "final" | "step";

export interface CheckpointManifest {
  kind: typeof MANIFEST_KIND;
  checkpoint: CheckpointKind;
  gate: string;
  run: string;
  node: string;
  step: number;
  dataset: string;
  rehearsal: boolean;
  bytes: number;
  files: number;
  sha256: string;
  source: string;
  collected: string;
  /** Whether what was carried back can be trained on from where it stood. A finished checkpoint can;
   * a rolling save cannot, because the optimizer's moments and the full-precision weights it would
   * need are several gigabytes and stay on the node the resume happens on. What came back is the
   * model, which can be measured, served, or given to a fresh run as its base. */
  resumable: boolean;
}

/** Where collected checkpoints stand: the worker's workbench, which outlives a session and a job,
 * rather than a checkout's own ignored folder, which does not. */
export function collectionRoot(worker = "worker"): string {
  return join(workbenchPath(worker), "laya-checkpoints");
}

export function stepName(step: number): string {
  return `step-${String(step).padStart(6, "0")}`;
}

/** One collected checkpoint's own folder. The gate and the step read straight off the name; the run
 * stands between them because two runs of one gate — a rehearsal and the real thing — reach the same
 * step numbers and are not the same checkpoint. */
export function collectedPath(root: string, gate: string, run: string, step: number): string {
  return join(root, gate, run, stepName(step));
}

export function packCommand(checkpoint: string, tarball: string, kind: CheckpointKind): string {
  return `bash ${nodePath(COLLECT_SCRIPT)} pack ${nodePath(checkpoint)} ${nodePath(tarball)} ${kind}`;
}

export function cleanCommand(tarball: string): string {
  return `bash ${nodePath(COLLECT_SCRIPT)} clean ${nodePath(tarball)}`;
}

export function tarballOnNode(run: string, gate: string, step: number): string {
  return `collect/${run}-${gate}-${stepName(step)}.tar`;
}

export interface Packed {
  packed: string;
  bytes: number;
  sha256: string;
  files: number;
}

export function parsePacked(text: string): Packed | string {
  const values = new Map<string, string>();

  for (const line of text.split("\n")) {
    const cut = line.indexOf("=");

    if (cut > 0 && /^[a-z][a-z0-9_]*$/.test(line.slice(0, cut).trim())) {
      values.set(line.slice(0, cut).trim(), line.slice(cut + 1).trim());
    }
  }
  if (values.has("fault")) {
    return values.get("fault") === "no-checkpoint" ? "노드에 그 체크포인트가 없어요." : `꾸러미로 묶지 못했어요 — ${values.get("fault")}`;
  }
  const packed = values.get("packed");
  const bytes = Number(values.get("bytes"));
  const sha256 = values.get("sha256") ?? "";

  if (packed === undefined || !Number.isFinite(bytes) || bytes <= 0 || !/^[0-9a-f]{64}$/.test(sha256)) {
    return "꾸러미를 묶었다는 답을 읽지 못했어요.";
  }

  return { packed, bytes, sha256, files: Number(values.get("files") ?? 0) || 0 };
}

export function readManifest(folder: string): CheckpointManifest | null {
  const path = join(folder, manifestFile);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const read: unknown = JSON.parse(readFileSync(path, "utf8"));

    return typeof read === "object" && read !== null && (read as CheckpointManifest).kind === MANIFEST_KIND
      ? read as CheckpointManifest
      : null;
  } catch {
    return null;
  }
}

/** Every checkpoint standing in the collection, read from the manifests themselves rather than from
 * an index kept beside them, which would be one more thing to fall out of step. */
export function collectedCheckpoints(root: string): CheckpointManifest[] {
  if (!existsSync(root)) {
    return [];
  }
  const found: CheckpointManifest[] = [];
  const walk = (folder: string, depth: number): void => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);

      if (!statSync(path).isDirectory() || name.endsWith(PARTIAL_SUFFIX)) {
        continue;
      }
      const manifest = readManifest(path);

      if (manifest !== null) {
        found.push(manifest);
      } else if (depth < 2) {
        walk(path, depth + 1);
      }
    }
  };

  walk(root, 0);

  return found;
}

export interface CollectAsk {
  runner: NodeRunner;
  console: string;
  node: string;
  gate: string;
  run: string;
  step: number;
  checkpoint: CheckpointKind;
  /** Where the checkpoint stands on the node, under its `~/bmo-laya`. */
  source: string;
  dataset: string;
  rehearsal: boolean;
  root?: string;
  overwrite?: boolean;
  /** How a tar is opened here. It is the one thing this does on its own machine rather than on the
   * node, so a test hands it a stand-in. */
  unpack?: (tarball: string, into: string) => Promise<{ code: number; stderr: string }>;
  now?: () => Date;
  say?: (line: string) => void;
}

async function openTar(tarball: string, into: string): Promise<{ code: number; stderr: string }> {
  const going = Bun.spawn(["tar", "-xf", tarball, "-C", into], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(going.stderr).text();

  return { code: await going.exited, stderr };
}

export interface Collected {
  folder: string;
  manifest: CheckpointManifest;
}

/** One checkpoint carried back whole. It is packed on the node, brought over as one file, checked
 * against the hash the node gave, unpacked under a partial name and only then given its own, so a
 * transfer cut short leaves nothing that reads as a collected checkpoint. */
export async function collectCheckpoint(ask: CollectAsk): Promise<Collected | string> {
  const refused = notTrainingNodes([ask.node]);
  if (refused !== null) {
    return refused;
  }

  const root = ask.root ?? collectionRoot();
  const now = ask.now ?? (() => new Date());
  const say = ask.say ?? (() => {});
  const target = collectedPath(root, ask.gate, ask.run, ask.step);
  const standing = readManifest(target);

  if (standing !== null && ask.overwrite !== true) {
    return `${target} 에 이미 ${standing.node} 에서 가져온 체크포인트가 있어요. `
      + "같은 게이트의 같은 스텝은 덮어쓰지 않아요 — 다른 이름으로 가져오거나 직접 지우고 다시 부르세요.";
  }

  const calls = nodeCalls(ask.runner, ask.console, ask.node);
  const exec = calls.exec;
  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);

  if (home === null) {
    return `노드가 답하지 않아요 — ${runFault(asked)}`;
  }

  const tarball = tarballOnNode(ask.run, ask.gate, ask.step);

  say(`${ask.node}: ${ask.gate} ${stepName(ask.step)} 를 묶는 중`);
  const packing = await exec(packCommand(ask.source, tarball, ask.checkpoint));
  const packed = parsePacked(packing.stdout);

  if (typeof packed === "string") {
    return packing.code === 0 ? packed : `${packed} — ${runFault(packing)}`;
  }

  mkdirSync(join(root, ".incoming"), { recursive: true });
  const carried = join(root, ".incoming", `${ask.run}-${ask.gate}-${stepName(ask.step)}.tar`);

  say(`${ask.node}: ${ask.gate} ${stepName(ask.step)} 를 가져오는 중 (${(packed.bytes / 1e6).toFixed(0)}MB)`);
  const brought = await calls.download(`${home}/bmo-laya/${tarball}`, carried, packed.bytes);

  if (brought.code !== 0) {
    return `가져오지 못했어요 — ${runFault(brought)}`;
  }
  if (!existsSync(carried)) {
    return "가져왔다는데 파일이 없어요.";
  }

  const here = createHash("sha256").update(readFileSync(carried)).digest("hex");

  if (here !== packed.sha256) {
    rmSync(carried, { force: true });

    return `가져온 꾸러미가 노드의 것과 달라요 — 노드 ${packed.sha256.slice(0, 12)}, 여기 ${here.slice(0, 12)}`;
  }

  const building = target + PARTIAL_SUFFIX;

  rmSync(building, { recursive: true, force: true });
  mkdirSync(building, { recursive: true });

  const unpacked = await (ask.unpack ?? openTar)(carried, building);

  if (unpacked.code !== 0) {
    rmSync(building, { recursive: true, force: true });

    return `꾸러미를 풀지 못했어요 — ${unpacked.stderr.trim().slice(-300)}`;
  }

  const manifest: CheckpointManifest = {
    kind: MANIFEST_KIND,
    checkpoint: ask.checkpoint,
    gate: ask.gate,
    run: ask.run,
    node: ask.node,
    step: ask.step,
    dataset: ask.dataset,
    rehearsal: ask.rehearsal,
    bytes: packed.bytes,
    files: packed.files,
    sha256: packed.sha256,
    source: ask.source,
    collected: now().toISOString(),
    resumable: ask.checkpoint === "final",
  };

  writeFileSync(join(building, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(root, ask.gate, ask.run), { recursive: true });
  renameSync(building, target);
  rmSync(carried, { force: true });
  await exec(cleanCommand(tarball));
  say(`${ask.node}: ${ask.gate} ${stepName(ask.step)} 를 ${target} 에 두었어요`);

  return { folder: target, manifest };
}

export function collectLines(manifests: readonly CheckpointManifest[]): string[] {
  if (manifests.length === 0) {
    return ["가져온 체크포인트가 아직 없어요."];
  }

  return manifests.map((one) =>
    `${one.gate}/${one.run}/${stepName(one.step)} · ${one.checkpoint === "final" ? "끝난 것" : "중간 것(모델만)"} · `
    + `${one.node} · ${(one.bytes / 1e6).toFixed(0)}MB · ${one.rehearsal ? "리허설" : "실제"} · ${one.collected}`);
}
