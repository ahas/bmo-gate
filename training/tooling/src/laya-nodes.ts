import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault } from "./node-calls";
import { SERVICE_NAME } from "./llm-install";
import { connectionCalls, readListedConnection, reservedAgainst, withoutBash } from "./node-reach";
import { distinct, listAt, nodeAt, objectAt, placementPath } from "./placement";
import { repositoryRoot } from "./roots";

import type { NodeCalls, NodeRunner } from "./node-calls";
import type { PlacementFile } from "./placement";

// The training environment on the nodes that train the split gates (docs/training.md, 「The
// nodes」): what each node carries, what has to be put there, and whether it is ready
// to take a gate. A node is reached as the node unit's node list says, a console node through its hub
// and an ssh node by a batch login, so everything here is a command handed to the node and an answer read back.
//
// The shell of it lives in two committed scripts that are uploaded and run — the probe reads and the
// setup installs — so what runs on a node is a file somebody can read rather than a string assembled
// here. This module composes the calls, reads the answers, and says what is missing.

// The name the training declares itself by to the card arbiter and the card master
// (weights/laya-train.card.toml), which a node's role names where the training stands beneath its services.
export const TRAINING_SERVICE = "laya-train";

// The machines the gates are trained on, which the training placement names (docs/training.md,
// 「The nodes」). They are not read from the node list because the list holds every machine the node
// unit reaches and only these train; a node of the service is among them only where its training gives the
// card way to the services (docs/llm-server.md, 「Training on a service node」).
export const TRAINING_PLACEMENT: PlacementFile<readonly string[]> = {
  file: "laya-training.json",
  shape: '{"nodes": ["<node>", …]}',
  read(value) {
    // An empty list is no training node at all: a pass trains nothing, and every node command refuses.
    const nodes = listAt(objectAt(value, "the file").nodes, "nodes").map((node, at) => nodeAt(node, `nodes[${at}]`));
    distinct(nodes, "nodes");
    return nodes;
  },
};

/** Why these nodes may not be given Laya's work, or null where every one of them is a training node.
 * Every command that sets up, reads, trains on or collects from a node asks this first, so a node
 * named by hand cannot put a run on a card another service holds. */
export function notTrainingNodes(nodes: readonly string[], training: readonly string[]): string | null {
  if (training.length === 0) {
    return `the training placement ${placementPath(TRAINING_PLACEMENT.file)} names no training node — there is no node to train or measure Laya on now`;
  }
  const others = nodes.filter((node) => !training.includes(node));

  return others.length === 0
    ? null
    : `${others.join(", ")}: not a training node — Laya is trained and measured on ${training.join(", ")} alone`;
}

/** The training nodes a run can use, each reached as its row in the node unit's node list says, and a line for each
 * node that dropped out of training: one whose login takes no bash. */
export type TrainingReach = { reached: Map<string, NodeCalls>; dropped: string[] };

/** How each named node is reached, or why one of them may not train Laya: a row that cannot be read, or
 * one reserving the node for another service, which carries no Laya training either. A node whose login
 * takes no bash is no fault of the run's and drops out instead (docs/training.md, 「The nodes」). */
export async function reachTrainingNodes(nodes: readonly string[], runner: NodeRunner, console: string, command?: readonly string[]): Promise<TrainingReach | string> {
  const reached = new Map<string, NodeCalls>();
  const dropped: string[] = [];
  for (const node of nodes) {
    const connection = await readListedConnection(node, runner, command);
    if (typeof connection === "string") {
      return connection;
    }
    // A node reserved for the Laya service takes its training too, and one the card master placed the
    // training on beneath its own services names it by the name it declares to the arbiter.
    const refused = reservedAgainst(SERVICE_NAME, node, connection);
    if (refused !== null && reservedAgainst(TRAINING_SERVICE, node, connection) !== null) {
      return refused;
    }
    const noBash = withoutBash(node, connection);
    if (noBash !== null) {
      dropped.push(`${noBash} — it drops out of training`);
      continue;
    }
    reached.set(node, connectionCalls(connection, runner, console));
  }
  return { reached, dropped };
}

/** What is said where every named node dropped out of training, so nothing is trained. */
export function noTrainingNodeLeft(dropped: readonly string[]): string {
  return `there is no node to train Laya on now — ${dropped.join("; ")}`;
}

/** Why the placement's nodes can train nothing now, or null where one of them can take a gate: what a
 * command asked to train says before it starts any of its work. */
export async function nothingToTrainOn(training: readonly string[], runner: NodeRunner, console: string, command?: readonly string[]): Promise<string | null> {
  const found = notTrainingNodes(training, training) ?? await reachTrainingNodes(training, runner, console, command);

  if (typeof found === "string") {
    return found;
  }
  return found.reached.size === 0 ? noTrainingNodeLeft(found.dropped) : null;
}

// The account's own folder on a node. No sudo, no system package, nothing outside it.
export const NODE_DIR = "bmo-laya";

// What a node needs to train, each where the repository keeps it: the training and the node's own
// scripts under `training/laya/`, and under `runtime/laya-server/` what the training shares with the
// service — the predictor, the measures, the pinned project file, the venv's setup and the card turn
// client a run waits its turn for the card through. The server and its unit belong to the Laya service on
// its own node and are put there by its own installer.
export const NODE_FILE_PATHS: readonly string[] = [
  "training/laya/finetune.py", "training/laya/balance.py", "training/laya/parking.py", "training/laya/calibrate.py",
  "training/laya/compare.py", "training/laya/resume.py", "training/laya/node-probe.sh", "training/laya/node-train.sh",
  "training/laya/node-collect.sh", "runtime/laya-server/predict.py", "runtime/laya-server/metrics.py",
  "runtime/laya-server/pyproject.toml", "runtime/laya-server/node-setup.sh", "runtime/laya-server/turn.py",
];

/** The node's files by the names they take there, side by side in its own folder. */
export const NODE_FILES: readonly string[] = NODE_FILE_PATHS.map((path) => basename(path));

/** Where the repository keeps one of the node's files. */
export function nodeFileSource(repository: string, name: string): string {
  const path = NODE_FILE_PATHS.find((one) => basename(one) === name);

  if (path === undefined) {
    throw new Error(`${name} is not a file a training node is given`);
  }

  return join(repository, path);
}

// What the setup script says on its last line, being the one thing a poll waits for.
export const SETUP_DONE = "LAYA-SETUP-DONE";

// The packages a training run cannot start without. bitsandbytes is only the savings extra's and no
// run uses it, so it is reported and not required.
export const REQUIRED_PACKAGES: readonly string[] = ["laya", "torch", "transformers", "safetensors"];

// Room for a run's own checkpoints: each keeps its newest two step checkpoints beside the model.
export const NEEDED_DISK_GB = 20;

export interface NodeProbe {
  host: string;
  os: string;
  gpu: string;
  vramTotalMb: number | null;
  vramFreeMb: number | null;
  gpuProcs: number | null;
  /** Whether the node's card arbiter has the card in use, a resting holder not counting; null where no
   * arbiter answers. */
  cardBusy: boolean | null;
  driver: string;
  cuda: string;
  cudaPath: string;
  python: string;
  cc: string;
  uv: string;
  venvPython: string;
  /** Whether the venv stands on uv's own interpreter; null where there is no venv or it cannot be told. */
  venvManaged: boolean | null;
  diskFreeGb: number | null;
  packages: Record<string, string>;
  digests: Record<string, string>;
  setupLast: string;
  setupRunning: boolean;
}

/** Where a file of ours sits on a node, as a path the node's own shell expands. Good for a command,
 * which is read by a shell; not for an upload, which is not. */
export function nodePath(...parts: string[]): string {
  return ["~", NODE_DIR, ...parts].join("/");
}

/** The same place written out whole. The transfer opens the path it is given without a shell in the
 * way, so a tilde in it would be a directory of that name. */
export function nodeFilePath(home: string, name: string): string {
  return [home.replace(/\/+$/, ""), NODE_DIR, name].join("/");
}

export function makeDirCommand(): string {
  return `mkdir -p ${nodePath()}`;
}

export function probeCommand(): string {
  return `bash ${nodePath("node-probe.sh")}`;
}

/** The setup, started and let go of. The hub stops a command it is streaming, and the stop reaches the
 * whole process group, so an install that takes minutes has to be detached from the call that starts
 * it and read back out of its log. */
export function setupLaunchCommand(): string {
  return `cd ${nodePath()} && chmod +x node-setup.sh node-probe.sh && rm -f setup.log && `
    + `setsid nohup bash node-setup.sh > setup.log 2>&1 < /dev/null & echo launched`;
}

export function setupTailCommand(lines = 60): string {
  return `tail -n ${lines} ${nodePath("setup.log")} 2>/dev/null || true`;
}

export interface SetupEnd {
  done: boolean;
  ok: boolean;
  fault: string | null;
}

/** What a setup log says about itself: still running, finished, or finished badly with the step it
 * broke on. */
export function parseSetupEnd(text: string): SetupEnd {
  const line = text.split("\n").map((one) => one.trim()).filter((one) => one.startsWith(SETUP_DONE)).at(-1);
  if (line === undefined) {
    return { done: false, ok: false, fault: null };
  }
  const said = line.slice(SETUP_DONE.length).trim();
  if (said === "ok") {
    return { done: true, ok: true, fault: null };
  }
  return { done: true, ok: false, fault: said.startsWith("failed:") ? said.slice("failed:".length) : said };
}

const numberOf = (value: string | undefined): number | null => {
  if (value === undefined || value === "none") {
    return null;
  }
  const read = Number(value);
  return Number.isFinite(read) ? read : null;
};

/** The probe's `key=value` lines as one reading. A line that is not ours is passed over; a probe with
 * no host in it is not a probe at all and says so by coming back null. */
export function parseProbe(text: string): NodeProbe | null {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const cut = line.indexOf("=");
    if (cut <= 0) {
      continue;
    }
    const key = line.slice(0, cut).trim();
    if (/^[a-z][a-z0-9_.-]*$/.test(key)) {
      values.set(key, line.slice(cut + 1).trim());
    }
  }
  if (!values.has("host")) {
    return null;
  }
  const said = (key: string) => values.get(key) ?? "none";
  const under = (prefix: string) => Object.fromEntries(
    [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]),
  );
  return {
    host: said("host"),
    os: said("os"),
    gpu: said("gpu"),
    vramTotalMb: numberOf(values.get("vram_total_mb")),
    vramFreeMb: numberOf(values.get("vram_free_mb")),
    gpuProcs: numberOf(values.get("gpu_procs")),
    cardBusy: said("card_busy") === "none" ? null : said("card_busy") === "yes",
    driver: said("driver"),
    cuda: said("cuda"),
    cudaPath: said("cuda_path"),
    python: said("python"),
    cc: said("cc"),
    uv: said("uv"),
    venvPython: said("venv_python"),
    venvManaged: said("venv_managed") === "none" ? null : said("venv_managed") === "yes",
    diskFreeGb: numberOf(values.get("disk_free_gb")),
    packages: under("pkg."),
    digests: under("sha."),
    setupLast: said("setup_last"),
    setupRunning: said("setup_running") === "yes",
  };
}

// What one gate's training reserves on the card, with room to spare (docs/laya-server.md, 「The
// training loop and calibration」: about 6.8 GB).
export const GATE_VRAM_MB = 7_000;

/** Why a node's card cannot take a gate now, or null where it can. Where the node's card arbiter
 * answers, its word decides: a holder resting on the card gives way to whoever asks, so the memory it
 * keeps there takes nothing (the arbiter's docs/node-arbiter.md, 「Resting」). Elsewhere the card is somebody else's for now
 * where it has less free than a gate reserves: another gate's run, or work nobody here started. A
 * process holding less — a resident server that has let its model go — leaves room, and counting it
 * as a taken card would keep every card it stands on from ever training. Where the free memory could
 * not be read, a process on the card is what takes it. */
export function cardTaken(probe: NodeProbe): string | null {
  if (probe.cardBusy !== null) {
    return probe.cardBusy ? "the card arbiter says the card is in use" : null;
  }
  if (probe.vramFreeMb !== null) {
    return probe.vramFreeMb < GATE_VRAM_MB
      ? `the card has ${probe.vramFreeMb}MB free, no room for a gate (${GATE_VRAM_MB}MB)`
      : null;
  }
  return (probe.gpuProcs ?? 0) > 0 ? `the card carries ${probe.gpuProcs} process${probe.gpuProcs === 1 ? "" : "es"}` : null;
}

/** A node whose card cannot take a gate is left alone rather than installed into underneath. */
export function nodeBusy(probe: NodeProbe): boolean {
  return cardTaken(probe) !== null;
}

/** A card as it stands right now: free, carrying a process, or not to be read at all. */
export type CardRead = { state: "free" } | { state: "taken" | "silent"; why: string };

/** The card read again right before anything is put on it. The card is shared with work that is not a
 * pass's, so what it carried when the node was stood up says nothing about it a gate later. */
export async function readCard(node: string, runner: NodeRunner, console: string, calls?: NodeCalls): Promise<CardRead> {
  const probed = await (calls ?? nodeCalls(runner, console, node)).exec(probeCommand());
  const probe = parseProbe(probed.stdout);
  if (probe === null) {
    return { state: "silent", why: `the node does not answer — ${runFault(probed)}` };
  }
  const taken = cardTaken(probe);
  return taken === null ? { state: "free" } : { state: "taken", why: taken };
}

/** The version `pyproject.toml` pins `laya` at, read from the file by Bun's own TOML reading rather than
 * kept beside it, so the pin has one place to be wrong. An exact pin is the one spelling the project file
 * gives it, `laya==<version>`. */
export function pinnedLaya(pyproject: string): string | null {
  const project = (Bun.TOML.parse(pyproject) as { project?: { dependencies?: unknown } }).project;
  const pins = Array.isArray(project?.dependencies) ? project.dependencies : [];
  const pin = pins.find((one): one is string => typeof one === "string" && one.startsWith("laya=="));

  return pin === undefined ? null : pin.slice("laya==".length);
}

export interface Readiness {
  ready: boolean;
  missing: string[];
}

/** Whether a node can take a gate, and what it is short of if it cannot. */
export function readiness(probe: NodeProbe | null, pinned: string | null, digests: Record<string, string>): Readiness {
  if (probe === null) {
    return { ready: false, missing: ["it does not answer the probe"] };
  }
  const missing: string[] = [];
  if (probe.gpu === "none") {
    missing.push("it has no GPU");
  }
  // The CUDA toolkit is read for the table alone: a run compiles nothing against it, and the driver and
  // torch's own CUDA build are what it trains on.
  if (probe.venvPython === "none") {
    missing.push("it has no venv");
  } else if (probe.venvManaged === false) {
    missing.push("its venv stands on the system's python, not uv's");
  }
  for (const name of REQUIRED_PACKAGES) {
    const version = probe.packages[name] ?? "none";
    if (version === "none") {
      missing.push(`${name} is not installed`);
    } else if (name === "laya" && pinned !== null && version !== pinned) {
      missing.push(`laya is ${version} where the pin is ${pinned}`);
    }
  }
  const stale = outdatedFiles(digests, probe);
  if (stale.length > 0) {
    missing.push(`the node's ${stale.join(", ")} differ from this checkout's`);
  }
  if (probe.diskFreeGb !== null && probe.diskFreeGb < NEEDED_DISK_GB) {
    missing.push(`${probe.diskFreeGb}GB of disk is left, below the ${NEEDED_DISK_GB}GB a run needs`);
  }
  const taken = cardTaken(probe);
  if (taken !== null) {
    missing.push(taken);
  }
  return { ready: missing.length === 0, missing };
}

/** Which of our files the node does not have as this checkout has them. A node with no probe needs all
 * of them. */
export function outdatedFiles(digests: Record<string, string>, probe: NodeProbe | null): string[] {
  return Object.keys(digests).filter((name) => probe === null || probe.digests[name] !== digests[name]).sort();
}

/** What this checkout's copies come to, which is what a node's are compared against. */
export function localDigests(repository: string = repositoryRoot()): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const name of NODE_FILES) {
    digests[name] = createHash("sha256").update(readFileSync(nodeFileSource(repository, name))).digest("hex");
  }
  return digests;
}

export type SetupOutcome = "already right" | "installed" | "failed" | "busy" | "unreachable" | "not asked";

export interface NodeOutcome {
  node: string;
  probe: NodeProbe | null;
  uploaded: string[];
  setup: SetupOutcome;
  ready: boolean;
  missing: string[];
  fault: string | null;
  seconds: number;
}

export interface StandOptions {
  runner: NodeRunner;
  console: string;
  /** How a node is reached, as the node unit's node list says; a console agent of its name where not given. */
  reach?: (node: string) => NodeCalls;
  /** The repository the node's files are carried from. */
  repository: string;
  digests: Record<string, string>;
  pinned: string | null;
  /** The training nodes the placement names, outside which nothing is stood up. */
  training: readonly string[];
  /** Read the node and change nothing. */
  check?: boolean;
  wait?: (ms: number) => Promise<void>;
  polls?: number;
  everyMs?: number;
  now?: () => number;
  say?: (line: string) => void;
}

/** One node stood up, and what it took. The order is fixed: read the node first, refuse a busy card
 * before anything is written to it, put across only the files that differ, and install only where the
 * reading says something is short. A node already right is read twice and touched not at all. */
export async function standNode(node: string, options: StandOptions): Promise<NodeOutcome> {
  const refused = notTrainingNodes([node], options.training);
  if (refused !== null) {
    throw new Error(refused);
  }

  const now = options.now ?? (() => Date.now());
  const say = options.say ?? (() => {});
  const started = now();
  const done = (outcome: Omit<NodeOutcome, "seconds">): NodeOutcome =>
    ({ ...outcome, seconds: Math.round((now() - started) / 100) / 10 });

  const calls = options.reach?.(node) ?? nodeCalls(options.runner, options.console, node);
  const exec = calls.exec;
  const silent = (fault: string) => done({ node, probe: null, uploaded: [], setup: "unreachable", ready: false,
    fault, missing: ["it does not answer the probe"] });

  // The account's own folder, asked of the node before anything is written to it: a transfer opens the
  // path it is handed with no shell in the way, so it is given one written out whole.
  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);
  if (home === null) {
    return silent(`the node does not answer — ${runFault(asked)}`);
  }
  const upload = async (name: string) => calls.upload(nodeFileSource(options.repository, name), nodeFilePath(home, name));

  await exec(makeDirCommand());
  const carriedEarly: string[] = [];
  let probed = await exec(probeCommand());
  let probe = parseProbe(probed.stdout);
  if (probe === null) {
    // A node that will not answer a probe it does not have yet is a node we have not stood up, so the
    // probe goes across first and is asked again. Only a second silence is the node being out of reach.
    // This one file goes across even where the caller only wanted to read, since it is how a node is
    // read at all; nothing is installed and nothing else is written.
    const carried = await upload("node-probe.sh");
    if (carried.code !== 0) {
      return silent(`the node does not answer — node-probe.sh could not be put across: ${runFault(carried)}`);
    }
    carriedEarly.push("node-probe.sh");
    probed = await exec(probeCommand());
    probe = parseProbe(probed.stdout);
    if (probe === null) {
      return silent(`the node does not answer — ${runFault(probed)}`);
    }
  }

  if (nodeBusy(probe)) {
    // A busy card is never installed under, but a node short of nothing else is ready: each gate reads
    // the card again before it starts and waits for it, as a service node's card is busy for a voice line.
    const verdict = readiness(probe, options.pinned, options.digests);
    const short = verdict.missing.filter((one) => one !== cardTaken(probe));
    return short.length === 0
      ? done({ node, probe, uploaded: carriedEarly, setup: "already right", ready: true, missing: [], fault: null })
      : done({ node, probe, uploaded: carriedEarly, setup: "busy", ready: false, missing: verdict.missing,
        fault: `${cardTaken(probe)} — left as it stands` });
  }

  const before = readiness(probe, options.pinned, options.digests);
  if (options.check === true) {
    return done({ node, probe, uploaded: carriedEarly, setup: "not asked", ready: before.ready, missing: before.missing, fault: null });
  }
  if (before.ready) {
    return done({ node, probe, uploaded: carriedEarly, setup: "already right", ready: true, missing: [], fault: null });
  }

  // A setup already in flight is waited on rather than started again: two installs into one venv is
  // how a half-installed environment is made, and this verb is meant to be run again as often as a
  // caller likes — including where the first call was the one that started what is still running.
  const uploaded = [...new Set([...carriedEarly, ...probe.setupRunning ? [] : outdatedFiles(options.digests, probe)])].sort();
  for (const name of uploaded) {
    say(`${node}: putting ${name} across`);
    const carried = await upload(name);
    if (carried.code !== 0) {
      return done({ node, probe, uploaded, setup: "failed", ready: false, missing: before.missing,
        fault: `${name} could not be put across — ${runFault(carried)}` });
    }
  }

  if (probe.setupRunning) {
    say(`${node}: waiting on the install already running`);
  } else {
    say(`${node}: standing the training environment up`);
    const launched = await exec(setupLaunchCommand());
    if (launched.code !== 0) {
      return done({ node, probe, uploaded, setup: "failed", ready: false, missing: before.missing,
        fault: `the install could not be started — ${runFault(launched)}` });
    }
  }

  const wait = options.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  const polls = options.polls ?? 80;
  const everyMs = options.everyMs ?? 15_000;
  let end: SetupEnd = { done: false, ok: false, fault: null };
  let tail = "";
  for (let poll = 0; poll < polls && !end.done; poll += 1) {
    await wait(everyMs);
    tail = (await exec(setupTailCommand())).stdout;
    end = parseSetupEnd(tail);
  }
  if (!end.done) {
    return done({ node, probe, uploaded, setup: "failed", ready: false, missing: before.missing,
      fault: `the install had not finished after ${Math.round(polls * everyMs / 1000)}s — its log is ${nodePath("setup.log")}` });
  }
  if (!end.ok) {
    return done({ node, probe, uploaded, setup: "failed", ready: false, missing: before.missing,
      fault: `the install broke at ${end.fault ?? "an unnamed step"} — its log is ${nodePath("setup.log")}` });
  }

  const after = parseProbe((await exec(probeCommand())).stdout);
  const verdict = readiness(after, options.pinned, options.digests);
  return done({ node, probe: after, uploaded, setup: verdict.ready ? "installed" : "failed", ready: verdict.ready,
    missing: verdict.missing, fault: verdict.ready ? null : "the install finished and the node is still short of something" });
}

export async function standNodes(nodes: readonly string[], options: StandOptions): Promise<NodeOutcome[]> {
  // Refused as a whole before any node is touched, so a list with one wrong name changes nothing.
  const refused = notTrainingNodes(nodes, options.training);
  if (refused !== null) {
    throw new Error(refused);
  }

  return Promise.all(nodes.map((node) => standNode(node, options)));
}

const shown = (value: string | number | null): string => value === null ? "—" : String(value);

// A Hangul or CJK letter takes two columns of a terminal where a Latin one takes a single, so a table
// padded by the count of characters comes out crooked wherever a cell carries one, such as a name a
// machine gives itself. The ranges are written by their escapes.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

export function printedWidth(text: string): number {
  return [...text].reduce((width, letter) => width + (WIDE.test(letter) ? 2 : 1), 0);
}

const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - printedWidth(text)));

// What became of a node, in the words the table says it in.
const SETUP_WORDS: Record<SetupOutcome, string> = {
  "already right": "already right",
  installed: "stood up",
  failed: "failed",
  busy: "card in use, left alone",
  unreachable: "out of reach",
  "not asked": "read only",
};

export function setupWord(outcome: SetupOutcome): string {
  return SETUP_WORDS[outcome];
}

/** The nodes side by side: one line a reading, one column a node, so what differs between them is read
 * across rather than hunted for. */
export function nodeTable(outcomes: readonly NodeOutcome[]): string {
  const rows: Array<[string, (one: NodeOutcome) => string]> = [
    ["ready", (one) => one.ready ? "yes" : "no"],
    ["done", (one) => setupWord(one.setup)],
    ["host", (one) => one.probe?.host ?? "—"],
    ["GPU", (one) => one.probe?.gpu ?? "—"],
    ["VRAM free/total", (one) => one.probe === null ? "—" : `${shown(one.probe.vramFreeMb)} / ${shown(one.probe.vramTotalMb)} MB`],
    ["processes on the card", (one) => one.probe === null ? "—" : shown(one.probe.gpuProcs)],
    ["driver", (one) => one.probe?.driver ?? "—"],
    ["CUDA", (one) => one.probe?.cuda ?? "—"],
    ["python", (one) => one.probe?.python ?? "—"],
    ["venv python", (one) => one.probe?.venvPython ?? "—"],
    ["uv", (one) => one.probe?.uv ?? "—"],
    ["laya", (one) => one.probe?.packages.laya ?? "—"],
    ["torch", (one) => one.probe?.packages.torch ?? "—"],
    ["transformers", (one) => one.probe?.packages.transformers ?? "—"],
    ["safetensors", (one) => one.probe?.packages.safetensors ?? "—"],
    ["disk free", (one) => one.probe?.diskFreeGb === undefined || one.probe?.diskFreeGb === null ? "—" : `${one.probe.diskFreeGb} GB`],
    ["files put across", (one) => String(one.uploaded.length)],
    ["seconds", (one) => String(one.seconds)],
  ];
  const head = ["", ...outcomes.map((one) => one.node)];
  const body = rows.map(([label, read]) => [label, ...outcomes.map(read)]);
  const widths = head.map((_, column) => Math.max(...[head, ...body].map((line) => printedWidth(line[column] ?? ""))));
  const line = (cells: string[]) => cells.map((cell, column) => pad(cell, widths[column]!)).join("  ").trimEnd();
  const table = [line(head), line(widths.map((width) => "-".repeat(width))), ...body.map(line)];
  // What a column has no room for goes underneath, a line a node: the files it was given, and
  // whatever it is still short of.
  const notes = outcomes.flatMap((one) => {
    const said = [
      ...one.uploaded.length > 0 ? [`put across ${one.uploaded.join(", ")}`] : [],
      ...one.fault === null ? [] : [one.fault],
      ...one.missing,
    ];

    return said.length > 0 ? [`${one.node}: ${said.join("; ")}`] : [];
  });
  return [table.join("\n"), ...notes.length > 0 ? ["", ...notes] : []].join("\n");
}
