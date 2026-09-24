import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault } from "./jake";
import { collectionRoot, manifestFile, PARTIAL_SUFFIX, readManifest } from "./laya-collect";
import { layaHealth, servingCheckpoint } from "./laya-service";
import { ENGINE_DIR, GATES_SETTINGS, LLM_NODE } from "./llm-install";

import type { NodeRunner } from "./jake";

// Putting a collected checkpoint in service on n6 (docs/llm-server.md, 「Putting a checkpoint in
// service」). The checkpoint is carried whole and checked before it is given its own name, and naming
// it for a gate is writing that gate's pair in the one settings file and restarting the engine. Which
// checkpoint a gate is answered by is 하스's choice; this only carries out the choice it is handed.

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
 * line and pair left as it stood. */
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

export interface ServeAsk {
  runner: NodeRunner;
  console: string;
  /** `<training gate>/<run>/step-<n>` under the collection. */
  checkpoint: string;
  /** The gate to name it for; carried only, where none. */
  gate?: string;
  node?: string;
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
    return `${ask.checkpoint} 는 <학습 게이트>/<실행>/step-<n> 모양이 아니에요`;
  }
  const folder = join(ask.root ?? collectionRoot(), ask.checkpoint);
  if (readManifest(folder) === null) {
    return `${folder} 에 수집한 체크포인트가 없어요 — bun scripts/laya-collect.ts 로 먼저 가져오세요`;
  }

  const say = ask.say ?? (() => {});
  const { exec, upload } = nodeCalls(ask.runner, ask.console, ask.node);
  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);
  if (home === null) {
    return `${ask.node} 가 답하지 않아요 — ${runFault(asked)}`;
  }

  const standing = await exec(standingCommand(ask.checkpoint, ask.dir));
  if (standing.stdout.includes("standing")) {
    say(`${ask.node}: ${ask.checkpoint} 는 이미 있어요`);

    return { carried: false };
  }

  const scratch = mkdtempSync(join(ask.tmpRoot ?? tmpdir(), "bmo-laya-carry-"));
  try {
    const local = join(scratch, "checkpoint.tar");
    const packed = await (ask.pack ?? tarUp)(folder, local);
    if (packed.code !== 0) {
      return `체크포인트를 묶지 못했어요 — ${packed.stderr.trim().slice(-300)}`;
    }
    const sha256 = await sha256Of(local);
    const tarball = `incoming/${ask.checkpoint.replaceAll("/", "-")}.tar`;

    const parts = await splitFile(local, ask.partBytes);
    say(`${ask.node}: ${ask.checkpoint} 를 올리는 중 (${(statSync(local).size / 1e6).toFixed(0)}MB, ${parts.length}조각)`);
    const made = await exec(`mkdir -p ~/${ask.dir}/incoming && rm -f ~/${ask.dir}/${tarball}.part-*`);
    if (made.code !== 0) {
      return `받을 자리를 만들지 못했어요 — ${runFault(made)}`;
    }
    for (const part of parts) {
      const sent = await upload(part, `${home}/${ask.dir}/${tarball}${part.slice(local.length)}`);
      if (sent.code !== 0) {
        return `체크포인트를 올리지 못했어요 — ${runFault(sent)}`;
      }
    }
    const placed = await exec(placeCommand(ask.checkpoint, tarball, sha256, ask.dir));
    if (placed.code !== 0 || !placed.stdout.includes("placed")) {
      return placed.stdout.includes("fault=hash")
        ? `${ask.node} 에 닿은 꾸러미가 여기서 묶은 것과 달라요 — 다시 부르세요`
        : `체크포인트를 풀지 못했어요 — ${runFault(placed)}`;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return { carried: true };
}

export function restartCommand(): string {
  return "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)} && systemctl --user restart bmo-llm-laya.service";
}

/** One checkpoint carried to n6, and named for a gate where one is given. */
export async function serveCheckpoint(ask: ServeAsk): Promise<Served | string> {
  if (!CHECKPOINT_PATH.test(ask.checkpoint)) {
    return `${ask.checkpoint} 는 <학습 게이트>/<실행>/step-<n> 모양이 아니에요`;
  }
  if (ask.gate !== undefined && !GATE_NAME.test(ask.gate)) {
    return `${ask.gate} 는 게이트 이름이 아니에요`;
  }

  const say = ask.say ?? (() => {});
  const node = ask.node ?? LLM_NODE;
  const put = await carryCheckpoint({ ...ask, node, dir: ENGINE_DIR });
  if (typeof put === "string") {
    return put;
  }
  const carried = put.carried;
  const { exec, upload } = nodeCalls(ask.runner, ask.console, node);
  const home = parseHome((await exec(homeCommand())).stdout);
  if (home === null) {
    return `${node} 가 답하지 않아요`;
  }

  if (ask.gate === undefined) {
    return { carried, gate: null };
  }

  const read = await exec(`cat ~/${GATES_SETTINGS} 2>/dev/null || true`);
  if (read.code !== 0) {
    return `게이트 설정을 읽지 못했어요 — ${runFault(read)}`;
  }
  const scratch = mkdtempSync(join(ask.tmpRoot ?? tmpdir(), "bmo-laya-settings-"));
  try {
    const local = join(scratch, "env");
    writeFileSync(local, namedSettings(read.stdout, ask.gate, ask.checkpoint));
    const sent = await upload(local, `${home}/${GATES_SETTINGS}`);
    if (sent.code !== 0) {
      return `게이트 설정을 쓰지 못했어요 — ${runFault(sent)}`;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  say(`${node}: ${ask.gate} 를 ${ask.checkpoint} 로 두고 엔진을 다시 띄우는 중`);
  const restarted = await exec(restartCommand());
  if (restarted.code !== 0) {
    return `엔진을 다시 띄우지 못했어요 — ${runFault(restarted)}`;
  }

  const health = ask.health ?? (() => layaHealth());
  const wait = ask.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  for (let poll = 0; poll < (ask.healthPolls ?? 60); poll += 1) {
    await wait(ask.healthEveryMs ?? 5_000);
    if (servingCheckpoint(await health(), ask.gate) === servedName(ask.checkpoint)) {
      return { carried, gate: ask.gate };
    }
  }

  return `엔진이 ${ask.gate} 를 ${ask.checkpoint} 로 답하지 않아요 — ${node} 의 journalctl --user -u bmo-llm-laya 를 보세요`;
}
