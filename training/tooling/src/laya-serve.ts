import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault } from "./node-calls";
import { collectionRoot, manifestFile, PARTIAL_SUFFIX, readManifest } from "./laya-collect";
import { layaHealth, servingCheckpoint } from "./laya-service";
import { ENGINE_DIR, GATES_SETTINGS } from "./llm-install";

import type { NodeCalls, NodeRunner } from "./node-calls";

// Putting a collected checkpoint in service on one of the service's nodes (docs/llm-server.md, 「Putting a
// checkpoint in service」). The checkpoint is carried whole and checked before it is given its own name, and naming
// it for a gate is writing that gate's pair in the one settings file and restarting the engine. Which
// checkpoint a gate is answered by is the owner's choice; this only carries out the choice it is handed.

/** A checkpoint as the collection and the engine both lay it out: `<training gate>/<run>/step-<n>`. */
const CHECKPOINT_PATH = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\/step-\d{6}$/;
const GATE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SETTING = "LAYA_CHECKPOINTS";
// The hub turns away a request body past 128 MB, so a checkpoint crosses in parts under that and is
// joined again on the node before its hash is checked.
export const PART_BYTES = 96 * 1024 * 1024;

/** What the engine calls a checkpoint in its health: the directory as the settings file names it. */
export function servedName(checkpoint: string): string {
  return `checkpoints/${checkpoint}`;
}

/** The settings file with the gate's pair written, or replaced where the gate has one, and every other
 * line and pair left as it stood. The file is the gates' settings file this project writes on the node, one
 * `LAYA_CHECKPOINTS="<gate>=<dir> …"` line among lines of the engine's own, so it is changed line by line:
 * an environment-file reading that wrote the file again whole would not keep the other lines as they
 * stand. */
export function namedSettings(text: string, gate: string, checkpoint: string): string {
  const pair = `${gate}=${servedName(checkpoint)}`;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trimStart().startsWith(`${SETTING}=`));

  if (at === -1) {
    const lead = text === "" || text.endsWith("\n") ? text : `${text}\n`;

    return `${lead}${SETTING}="${pair}"\n`;
  }

  const value = lines[at]!.slice(lines[at]!.indexOf("=") + 1).trim().replace(/^"(.*)"$/, "$1");
  const pairs = value.split(/\s+/).filter((one) => one !== "");
  const standing = pairs.findIndex((one) => one.startsWith(`${gate}=`));

  if (standing === -1) {
    pairs.push(pair);
  } else {
    pairs[standing] = pair;
  }
  lines[at] = `${SETTING}="${pairs.join(" ")}"`;

  return lines.join("\n");
}

/** The settings file with the gate's pair taken out, every other line and pair left as it stood, or
 * null where the gate has no pair to take out. */
export function releasedSettings(text: string, gate: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trimStart().startsWith(`${SETTING}=`));

  if (at === -1) {
    return null;
  }

  const value = lines[at]!.slice(lines[at]!.indexOf("=") + 1).trim().replace(/^"(.*)"$/, "$1");
  const pairs = value.split(/\s+/).filter((one) => one !== "");
  const kept = pairs.filter((one) => !one.startsWith(`${gate}=`));

  if (kept.length === pairs.length) {
    return null;
  }
  lines[at] = `${SETTING}="${kept.join(" ")}"`;

  return lines.join("\n");
}

export interface ServeAsk {
  runner: NodeRunner;
  console: string;
  /** `<training gate>/<run>/step-<n>` under the collection. */
  checkpoint: string;
  /** The gate to name it for; carried only, where none. */
  gate?: string;
  /** One of the service's nodes, which its placement names. */
  node: string;
  /** How the node is reached; through the node console by its name where not given. */
  calls?: NodeCalls;
  root?: string;
  tmpRoot?: string;
  /** How the tar is made here, the one thing done on this machine rather than on the node. */
  pack?: (folder: string, tarball: string) => Promise<{ code: number; stderr: string }>;
  /** How large a part crosses at most; the hub's limit allows otherwise. */
  partBytes?: number;
  /** The engine's health as the key holder is given it, or null where it does not answer. */
  health?: () => Promise<Record<string, unknown> | null>;
  wait?: (ms: number) => Promise<void>;
  healthPolls?: number;
  healthEveryMs?: number;
  say?: (line: string) => void;
}

export interface Served {
  /** Whether it was carried now, rather than found standing on the node already. */
  carried: boolean;
  /** The gate it now answers, where one was named. */
  gate: string | null;
}

async function tarUp(folder: string, tarball: string): Promise<{ code: number; stderr: string }> {
  const going = Bun.spawn(["tar", "-cf", tarball, "-C", folder, "."], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(going.stderr).text();

  return { code: await going.exited, stderr };
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
}

/** The file split into parts of at most partBytes each, written beside it, in order. */
export async function splitFile(path: string, partBytes: number = PART_BYTES): Promise<string[]> {
  const whole = Bun.file(path);
  const parts: string[] = [];

  for (let start = 0; start < whole.size; start += partBytes) {
    const part = `${path}.part-${String(parts.length).padStart(3, "0")}`;
    // Read into memory first: Bun.write handed a slice of a file copies the whole file.
    await Bun.write(part, await whole.slice(start, Math.min(start + partBytes, whole.size)).arrayBuffer());
    parts.push(part);
  }

  return parts;
}

/** Placing the tarball once its parts have landed: joined, checked against the hash made here,
 * unpacked under a partial name and only then given its own, and the parts and the tarball let go of
 * either way. */
export function placeCommand(checkpoint: string, tarball: string, sha256: string, dir: string = ENGINE_DIR): string {
  const target = `checkpoints/${checkpoint}`;
  const partial = `${target}${PARTIAL_SUFFIX}`;

  return `cd ~/${dir} && cat ${tarball}.part-* > ${tarball} && rm -f ${tarball}.part-*`
    + ` && if [ "$(sha256sum ${tarball} | cut -d' ' -f1)" != ${sha256} ]; then rm -f ${tarball}; echo fault=hash; exit 1; fi`
    + ` && mkdir -p $(dirname ${target}) && rm -rf ${partial} && mkdir -p ${partial} && tar -xf ${tarball} -C ${partial} && mv ${partial} ${target}`
    + ` && rm -f ${tarball} && echo placed`;
}

export function standingCommand(checkpoint: string, dir: string = ENGINE_DIR): string {
  return `test -f ~/${dir}/checkpoints/${checkpoint}/${manifestFile} && echo standing || echo absent`;
}

export interface CarryAsk {
  runner: NodeRunner;
  console: string;
  node: string;
  /** How the node is reached; through the node console by its name where not given. */
  calls?: NodeCalls;
  /** `<training gate>/<run>/step-<n>` under the collection. */
  checkpoint: string;
  /** The folder under the node's home it lands in, as `checkpoints/<checkpoint>`. */
  dir: string;
  root?: string;
  tmpRoot?: string;
  pack?: (folder: string, tarball: string) => Promise<{ code: number; stderr: string }>;
  partBytes?: number;
  say?: (line: string) => void;
}

/** A collected checkpoint put on a node whole: packed here, carried in parts under the hub's limit,
 * joined and checked against the hash made here, and given its own name only once unpacked. One
 * already standing there is left as it is. */
export async function carryCheckpoint(ask: CarryAsk): Promise<{ carried: boolean } | string> {
  if (!CHECKPOINT_PATH.test(ask.checkpoint)) {
    return `${ask.checkpoint} is not of the shape <training gate>/<run>/step-<n>`;
  }
  const folder = join(ask.root ?? collectionRoot(), ask.checkpoint);
  if (readManifest(folder) === null) {
    return `no collected checkpoint stands in ${folder} — carry it back with bun scripts/laya-collect.ts first`;
  }

  const say = ask.say ?? (() => {});
  const { exec, upload } = ask.calls ?? nodeCalls(ask.runner, ask.console, ask.node);
  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);
  if (home === null) {
    return `${ask.node} does not answer — ${runFault(asked)}`;
  }

  const standing = await exec(standingCommand(ask.checkpoint, ask.dir));
  if (standing.stdout.includes("standing")) {
    say(`${ask.node}: ${ask.checkpoint} stands there already`);

    return { carried: false };
  }

  const scratch = mkdtempSync(join(ask.tmpRoot ?? tmpdir(), "bmo-laya-carry-"));
  try {
    const local = join(scratch, "checkpoint.tar");
    const packed = await (ask.pack ?? tarUp)(folder, local);
    if (packed.code !== 0) {
      return `the checkpoint could not be packed — ${packed.stderr.trim().slice(-300)}`;
    }
    const sha256 = await sha256Of(local);
    const tarball = `incoming/${ask.checkpoint.replaceAll("/", "-")}.tar`;

    const parts = await splitFile(local, ask.partBytes);
    say(`${ask.node}: putting ${ask.checkpoint} across (${(statSync(local).size / 1e6).toFixed(0)}MB, ${parts.length} parts)`);
    const made = await exec(`mkdir -p ~/${ask.dir}/incoming && rm -f ~/${ask.dir}/${tarball}.part-*`);
    if (made.code !== 0) {
      return `the place to receive it could not be made — ${runFault(made)}`;
    }
    for (const part of parts) {
      const sent = await upload(part, `${home}/${ask.dir}/${tarball}${part.slice(local.length)}`);
      if (sent.code !== 0) {
        return `the checkpoint could not be put across — ${runFault(sent)}`;
      }
    }
    const placed = await exec(placeCommand(ask.checkpoint, tarball, sha256, ask.dir));
    if (placed.code !== 0 || !placed.stdout.includes("placed")) {
      return placed.stdout.includes("fault=hash")
        ? `the package that reached ${ask.node} differs from the one packed here — ask again`
        : `the checkpoint could not be unpacked — ${runFault(placed)}`;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return { carried: true };
}

export function restartCommand(): string {
  return "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)} && systemctl --user restart bmo-llm-laya.service";
}

/** One checkpoint carried to one of the service's nodes, and named for a gate where one is given. */
export async function serveCheckpoint(ask: ServeAsk): Promise<Served | string> {
  if (!CHECKPOINT_PATH.test(ask.checkpoint)) {
    return `${ask.checkpoint} is not of the shape <training gate>/<run>/step-<n>`;
  }
  if (ask.gate !== undefined && !GATE_NAME.test(ask.gate)) {
    return `${ask.gate} is not a gate's name`;
  }

  const say = ask.say ?? (() => {});
  const node = ask.node;
  const put = await carryCheckpoint({ ...ask, node, dir: ENGINE_DIR });
  if (typeof put === "string") {
    return put;
  }
  const carried = put.carried;
  const { exec, upload } = ask.calls ?? nodeCalls(ask.runner, ask.console, node);
  const home = parseHome((await exec(homeCommand())).stdout);
  if (home === null) {
    return `${node} does not answer`;
  }

  if (ask.gate === undefined) {
    return { carried, gate: null };
  }

  const read = await exec(`cat ~/${GATES_SETTINGS} 2>/dev/null || true`);
  if (read.code !== 0) {
    return `the gates' settings could not be read — ${runFault(read)}`;
  }
  const scratch = mkdtempSync(join(ask.tmpRoot ?? tmpdir(), "bmo-laya-settings-"));
  try {
    const local = join(scratch, "env");
    writeFileSync(local, namedSettings(read.stdout, ask.gate, ask.checkpoint));
    const sent = await upload(local, `${home}/${GATES_SETTINGS}`);
    if (sent.code !== 0) {
      return `the gates' settings could not be written — ${runFault(sent)}`;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  say(`${node}: naming ${ask.checkpoint} for ${ask.gate} and restarting the engine`);
  const restarted = await exec(restartCommand());
  if (restarted.code !== 0) {
    return `the engine could not be restarted — ${runFault(restarted)}`;
  }

  const health = ask.health ?? (() => layaHealth());
  const wait = ask.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  for (let poll = 0; poll < (ask.healthPolls ?? 60); poll += 1) {
    await wait(ask.healthEveryMs ?? 5_000);
    if (servingCheckpoint(await health(), ask.gate) === servedName(ask.checkpoint)) {
      return { carried, gate: ask.gate };
    }
  }

  return `the engine does not answer ${ask.gate} with ${ask.checkpoint} — see journalctl --user -u bmo-llm-laya on ${node}`;
}

export interface ReleaseAsk {
  runner: NodeRunner;
  console: string;
  /** The gate, as the gate service asks it, that the engine stops answering. */
  gate: string;
  node: string;
  calls?: NodeCalls;
  tmpRoot?: string;
  health?: () => Promise<Record<string, unknown> | null>;
  wait?: (ms: number) => Promise<void>;
  healthPolls?: number;
  healthEveryMs?: number;
  say?: (line: string) => void;
}

/** A gate the gate service no longer asks taken out of one node's settings, and the engine restarted without it.
 * The checkpoint it was answered by stays where it was carried. A node without the gate's pair is
 * left as it is. */
export async function releaseGate(ask: ReleaseAsk): Promise<{ released: boolean } | string> {
  if (!GATE_NAME.test(ask.gate)) {
    return `${ask.gate} is not a gate's name`;
  }

  const say = ask.say ?? (() => {});
  const { exec, upload } = ask.calls ?? nodeCalls(ask.runner, ask.console, ask.node);
  const home = parseHome((await exec(homeCommand())).stdout);
  if (home === null) {
    return `${ask.node} does not answer`;
  }

  const read = await exec(`cat ~/${GATES_SETTINGS} 2>/dev/null || true`);
  if (read.code !== 0) {
    return `the gates' settings could not be read — ${runFault(read)}`;
  }
  const released = releasedSettings(read.stdout, ask.gate);
  if (released === null) {
    return { released: false };
  }
  const scratch = mkdtempSync(join(ask.tmpRoot ?? tmpdir(), "bmo-laya-settings-"));
  try {
    const local = join(scratch, "env");
    writeFileSync(local, released);
    const sent = await upload(local, `${home}/${GATES_SETTINGS}`);
    if (sent.code !== 0) {
      return `the gates' settings could not be written — ${runFault(sent)}`;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  say(`${ask.node}: taking ${ask.gate} out of the settings and restarting the engine`);
  const restarted = await exec(restartCommand());
  if (restarted.code !== 0) {
    return `the engine could not be restarted — ${runFault(restarted)}`;
  }

  const health = ask.health ?? (() => layaHealth());
  const wait = ask.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  for (let poll = 0; poll < (ask.healthPolls ?? 60); poll += 1) {
    await wait(ask.healthEveryMs ?? 5_000);
    const now = await health();
    if (now !== null && servingCheckpoint(now, ask.gate) === null) {
      return { released: true };
    }
  }

  return `the engine still answers ${ask.gate}, or has not come back — see journalctl --user -u bmo-llm-laya on ${ask.node}`;
}
