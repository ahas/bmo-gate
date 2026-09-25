import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault } from "./jake";
import { sourceRoot } from "./roots";

import type { NodeRunner } from "./jake";

// The training environment on the nodes that train the split gates (docs/training.md, 「The
// nodes」): what each node carries, what has to be put there, and whether it is ready
// to take a gate. A node is reached through its jake hub rather than by SSH, so everything here is a
// command handed to the jake console and an answer read back from it.
//
// The shell of it lives in two committed scripts that are uploaded and run — the probe reads and the
// setup installs — so what runs on a node is a file somebody can read rather than a string assembled
// here. This module composes the calls, reads the answers, and says what is missing.

// The four machines the ten gates are trained on. They are named rather than read from the node table
// because the table holds every machine BMO reaches and only these four train. n6 is not among them:
// it serves the checkpoints (docs/llm-server.md), and a training run would take their card.
export const TRAINING_NODES: readonly string[] = ["n2", "n3", "n4", "n5"];

/** Why these nodes may not be given Laya's work, or null where every one of them is a training node.
 * Every command that sets up, reads, trains on or collects from a node asks this first, so a node
 * named by hand cannot put a run on a card another service holds. */
export function notTrainingNodes(nodes: readonly string[]): string | null {
  const others = nodes.filter((node) => !TRAINING_NODES.includes(node));

  return others.length === 0
    ? null
    : `${others.join(", ")} 은(는) 학습 노드가 아니에요 — Laya 학습과 측정은 ${TRAINING_NODES.join(", ")} 에서만 해요`;
}

// The account's own folder on a node. No sudo, no system package, nothing outside it.
export const NODE_DIR = "bmo-laya";

// What a node needs to train. The server and its unit belong to the Laya service on n6 and are put
// there by its own installer.
export const NODE_FILES: readonly string[] = [
  "finetune.py", "calibrate.py", "compare.py", "resume.py", "metrics.py", "pyproject.toml", "node-probe.sh", "node-setup.sh", "node-train.sh", "node-collect.sh",
];

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

/** A node with a process on its card is somebody else's for now: another gate's run, or a job nobody
 * here started. It is left alone rather than installed into underneath. */
export function nodeBusy(probe: NodeProbe): boolean {
  return (probe.gpuProcs ?? 0) > 0;
}

/** A card as it stands right now: free, carrying a process, or not to be read at all. */
export type CardRead = { state: "free" } | { state: "taken" | "silent"; why: string };

/** The card read again right before anything is put on it. The card is shared with work that is not a
 * pass's, so what it carried when the node was stood up says nothing about it a gate later. */
export async function readCard(node: string, runner: NodeRunner, console: string): Promise<CardRead> {
  const probed = await nodeCalls(runner, console, node).exec(probeCommand());
  const probe = parseProbe(probed.stdout);
  if (probe === null) {
    return { state: "silent", why: `노드가 답하지 않아요 — ${runFault(probed)}` };
  }
  return nodeBusy(probe) ? { state: "taken", why: `카드에 프로세스가 ${probe.gpuProcs}개 올라가 있어요` } : { state: "free" };
}

/** The version `pyproject.toml` pins `laya` at, read from the file rather than kept beside it, so the
 * pin has one place to be wrong. */
export function pinnedLaya(pyproject: string): string | null {
  return /(?:^|\n)\s*"laya==([^"]+)"/.exec(pyproject)?.[1] ?? null;
}

export interface Readiness {
  ready: boolean;
  missing: string[];
}

/** Whether a node can take a gate, and what it is short of if it cannot. */
export function readiness(probe: NodeProbe | null, pinned: string | null, digests: Record<string, string>): Readiness {
  if (probe === null) {
    return { ready: false, missing: ["살펴보기에 답하지 않아요"] };
  }
  const missing: string[] = [];
  if (probe.gpu === "none") {
    missing.push("GPU가 없어요");
  }
  if (probe.cuda === "none") {
    missing.push("CUDA가 없어요");
  }
  if (probe.venvPython === "none") {
    missing.push("가상 환경이 없어요");
  } else if (probe.venvManaged === false) {
    missing.push("가상 환경이 uv 파이썬이 아니라 시스템 파이썬 위에 서 있어요");
  }
  for (const name of REQUIRED_PACKAGES) {
    const version = probe.packages[name] ?? "none";
    if (version === "none") {
      missing.push(`${name}가 깔려 있지 않아요`);
    } else if (name === "laya" && pinned !== null && version !== pinned) {
      missing.push(`laya가 ${version}인데 고정은 ${pinned}이에요`);
    }
  }
  const stale = outdatedFiles(digests, probe);
  if (stale.length > 0) {
    missing.push(`노드의 ${stale.join(", ")}가 이 체크아웃의 것이 아니에요`);
  }
  if (probe.diskFreeGb !== null && probe.diskFreeGb < NEEDED_DISK_GB) {
    missing.push(`남은 디스크가 ${probe.diskFreeGb}GB로 한 판에 필요한 ${NEEDED_DISK_GB}GB보다 적어요`);
  }
  if (nodeBusy(probe)) {
    missing.push(`카드에 프로세스가 ${probe.gpuProcs}개 올라가 있어요`);
  }
  return { ready: missing.length === 0, missing };
}

/** Which of our files the node does not have as this checkout has them. A node with no probe needs all
 * of them. */
export function outdatedFiles(digests: Record<string, string>, probe: NodeProbe | null): string[] {
  return Object.keys(digests).filter((name) => probe === null || probe.digests[name] !== digests[name]).sort();
}

/** What this checkout's copies come to, which is what a node's are compared against. */
export function localDigests(folder: string = join(sourceRoot(), "laya-server")): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const name of NODE_FILES) {
    digests[name] = createHash("sha256").update(readFileSync(join(folder, name))).digest("hex");
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
  folder: string;
  digests: Record<string, string>;
  pinned: string | null;
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
  const refused = notTrainingNodes([node]);
  if (refused !== null) {
    throw new Error(refused);
  }

  const now = options.now ?? (() => Date.now());
  const say = options.say ?? (() => {});
  const started = now();
  const done = (outcome: Omit<NodeOutcome, "seconds">): NodeOutcome =>
    ({ ...outcome, seconds: Math.round((now() - started) / 100) / 10 });

  const calls = nodeCalls(options.runner, options.console, node);
  const exec = calls.exec;
  const silent = (fault: string) => done({ node, probe: null, uploaded: [], setup: "unreachable", ready: false,
    fault, missing: ["살펴보기에 답하지 않아요"] });

  // The account's own folder, asked of the node before anything is written to it: a transfer opens the
  // path it is handed with no shell in the way, so it is given one written out whole.
  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);
  if (home === null) {
    return silent(`노드가 답하지 않아요 — ${runFault(asked)}`);
  }
  const upload = async (name: string) => calls.upload(join(options.folder, name), nodeFilePath(home, name));

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
      return silent(`노드가 답하지 않아요 — node-probe.sh 를 올리지 못했어요: ${runFault(carried)}`);
    }
    carriedEarly.push("node-probe.sh");
    probed = await exec(probeCommand());
    probe = parseProbe(probed.stdout);
    if (probe === null) {
      return silent(`노드가 답하지 않아요 — ${runFault(probed)}`);
    }
  }

  if (nodeBusy(probe)) {
    const verdict = readiness(probe, options.pinned, options.digests);
    return done({ node, probe, uploaded: carriedEarly, setup: "busy", ready: false, missing: verdict.missing,
      fault: `카드에 이미 프로세스가 ${probe.gpuProcs}개 있어 그대로 두었어요` });
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
    say(`${node}: ${name} 올리는 중`);
    const carried = await upload(name);
    if (carried.code !== 0) {
      return done({ node, probe, uploaded, setup: "failed", ready: false, missing: before.missing,
        fault: `${name}를 올리지 못했어요 — ${runFault(carried)}` });
    }
  }

  if (probe.setupRunning) {
    say(`${node}: 이미 실행 중인 설치를 기다리는 중`);
  } else {
    say(`${node}: 학습 환경 세우는 중`);
    const launched = await exec(setupLaunchCommand());
    if (launched.code !== 0) {
      return done({ node, probe, uploaded, setup: "failed", ready: false, missing: before.missing,
        fault: `설치를 시작하지 못했어요 — ${runFault(launched)}` });
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
      fault: `${Math.round(polls * everyMs / 1000)}초가 지나도 설치가 끝나지 않았어요 — 기록은 ${nodePath("setup.log")}에 있어요` });
  }
  if (!end.ok) {
    return done({ node, probe, uploaded, setup: "failed", ready: false, missing: before.missing,
      fault: `설치가 ${end.fault ?? "이름 없는 자리"}에서 깨졌어요 — 기록은 ${nodePath("setup.log")}에 있어요` });
  }

  const after = parseProbe((await exec(probeCommand())).stdout);
  const verdict = readiness(after, options.pinned, options.digests);
  return done({ node, probe: after, uploaded, setup: verdict.ready ? "installed" : "failed", ready: verdict.ready,
    missing: verdict.missing, fault: verdict.ready ? null : "설치는 끝났는데 아직 모자란 것이 있어요" });
}

export async function standNodes(nodes: readonly string[], options: StandOptions): Promise<NodeOutcome[]> {
  // Refused as a whole before any node is touched, so a list with one wrong name changes nothing.
  const refused = notTrainingNodes(nodes);
  if (refused !== null) {
    throw new Error(refused);
  }

  return Promise.all(nodes.map((node) => standNode(node, options)));
}

const shown = (value: string | number | null): string => value === null ? "—" : String(value);

// A Hangul or CJK letter takes two columns of a terminal where a Latin one takes a single, so a table
// padded by the count of characters comes out crooked. The cells here are Korean labels beside Latin
// versions, which is exactly where that shows.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

export function printedWidth(text: string): number {
  return [...text].reduce((width, letter) => width + (WIDE.test(letter) ? 2 : 1), 0);
}

const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - printedWidth(text)));

// What became of a node, in the words the table says it in.
const SETUP_WORDS: Record<SetupOutcome, string> = {
  "already right": "그대로 좋음",
  installed: "세움",
  failed: "실패",
  busy: "쓰는 중이라 건드리지 않음",
  unreachable: "닿지 않음",
  "not asked": "보기만 함",
};

export function setupWord(outcome: SetupOutcome): string {
  return SETUP_WORDS[outcome];
}

/** The nodes side by side: one line a reading, one column a node, so what differs between them is read
 * across rather than hunted for. */
export function nodeTable(outcomes: readonly NodeOutcome[]): string {
  const rows: Array<[string, (one: NodeOutcome) => string]> = [
    ["준비됨", (one) => one.ready ? "예" : "아니요"],
    ["한 일", (one) => setupWord(one.setup)],
    ["호스트", (one) => one.probe?.host ?? "—"],
    ["GPU", (one) => one.probe?.gpu ?? "—"],
    ["VRAM 여유/전체", (one) => one.probe === null ? "—" : `${shown(one.probe.vramFreeMb)} / ${shown(one.probe.vramTotalMb)} MB`],
    ["카드 위 프로세스", (one) => one.probe === null ? "—" : shown(one.probe.gpuProcs)],
    ["드라이버", (one) => one.probe?.driver ?? "—"],
    ["CUDA", (one) => one.probe?.cuda ?? "—"],
    ["파이썬", (one) => one.probe?.python ?? "—"],
    ["가상 환경 파이썬", (one) => one.probe?.venvPython ?? "—"],
    ["uv", (one) => one.probe?.uv ?? "—"],
    ["laya", (one) => one.probe?.packages.laya ?? "—"],
    ["torch", (one) => one.probe?.packages.torch ?? "—"],
    ["transformers", (one) => one.probe?.packages.transformers ?? "—"],
    ["safetensors", (one) => one.probe?.packages.safetensors ?? "—"],
    ["남은 디스크", (one) => one.probe?.diskFreeGb === undefined || one.probe?.diskFreeGb === null ? "—" : `${one.probe.diskFreeGb} GB`],
    ["올린 파일", (one) => one.uploaded.length === 0 ? "없음" : `${one.uploaded.length}개`],
    ["걸린 초", (one) => String(one.seconds)],
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
      ...one.uploaded.length > 0 ? [`올린 파일 ${one.uploaded.join(", ")}`] : [],
      ...one.fault === null ? [] : [one.fault],
      ...one.missing,
    ];

    return said.length > 0 ? [`${one.node}: ${said.join("; ")}`] : [];
  });
  return [table.join("\n"), ...notes.length > 0 ? ["", ...notes] : []].join("\n");
}
