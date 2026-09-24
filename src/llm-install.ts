import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault, spawnRunner } from "./jake";
import { dataPath, homeDir, sourceRoot } from "./roots";

import type { NodeRunner } from "./jake";

// Putting the house LLM service on n6 (docs/llm-server.md, 「Installing and updating」). The node is a
// jake node, so everything that reaches it is a command or a transfer handed to the jake console; the
// main-host end — the key, the tunnel's authorized entry, the tunnel's door — is written here on this
// machine. Each step leaves alone what already stands, so the install is run again to update as often
// as one likes.
//
// The service key is read or made here, carried to the node only inside a file, and never written
// into a command, an answer or a line said aloud.

/** The machine the service stands on. */
export const LLM_NODE = "n6";

/** The node's own folder for the service, and the one for its settings and secrets. */
export const SERVICE_DIR = "bmo-llm";
export const CONFIG_DIR = ".config/bmo-llm";

/** What goes across from `llm-server/`. The tests stay here. */
export const SERVICE_FILES: readonly string[] = [
  "front.py", "ws-dial.py", "pyproject.toml", "node-setup.sh", "bmo-llm-vllm.service", "bmo-llm-front.service", "bmo-llm-tunnel.service",
];

export const UNITS: readonly string[] = ["bmo-llm-vllm.service", "bmo-llm-front.service", "bmo-llm-tunnel.service"];

/** What the setup says on its last line, being the one thing a poll waits for. */
export const SETUP_DONE = "LLM-SETUP-DONE";

/** The name main-host's host key is pinned under, and the one listen the tunnel is allowed there. */
export const TUNNEL_ALIAS = "main-host";
export const TUNNEL_LISTEN = "127.0.0.1:18010";

/** The tunnel's door on main-host, a unit of this checkout linked where the user manager reads it. */
export const BRIDGE_UNIT = "bmo-llm-bridge.service";

export const TUNNEL_KEY = `${CONFIG_DIR}/tunnel_ed25519`;

/** Where the service answers on main-host once the tunnel stands. */
export const HEALTH_URL = `http://${TUNNEL_LISTEN}/health`;

export function serviceKeyPath(): string {
  return dataPath("env", "n6.key");
}

export type InstallStep =
  | "key" | "home" | "env" | "upload" | "setup" | "tunnel-key" | "authorized-keys" | "bridge" | "known-hosts" | "units" | "health";

export interface InstallOutcome {
  ok: boolean;
  /** The step it stopped on, where it stopped. */
  step: InstallStep | null;
  fault: string | null;
  /** The steps that ran to the end, in order. */
  done: InstallStep[];
}

export interface InstallOptions {
  runner: NodeRunner;
  /** What runs a command on main-host itself; a shell here otherwise. */
  local?: NodeRunner;
  /** The checkout the bridge unit is linked from. */
  checkout?: string;
  console: string;
  node?: string;
  /** The folder the service's files are uploaded from. */
  folder?: string;
  keyPath?: string;
  authorizedKeysPath?: string;
  hostKeyPath?: string;
  /** Where the private temporary files are made. */
  tmpRoot?: string;
  health?: () => Promise<boolean>;
  wait?: (ms: number) => Promise<void>;
  setupPolls?: number;
  setupEveryMs?: number;
  healthPolls?: number;
  healthEveryMs?: number;
  say?: (line: string) => void;
}

/** The service key: read where it stands, made once where it does not. A key found with any
 * permission but 0600 is refused rather than used, since it may already have been read. */
export function ensureKey(path: string): { key: string; made: boolean } | string {
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      return `${path} 의 권한이 0600 이 아니에요 (${mode.toString(8)})`;
    }
    const key = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(key) ? { key, made: false } : `${path} 가 서비스 키 모양이 아니에요`;
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  // Exclusive, so two installs at once cannot write two keys over each other.
  writeFileSync(path, `${key}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);

  return { key, made: true };
}

/** The node's environment file. The key is in it twice, for the front and for vLLM. */
export function envFileText(key: string, home: string): string {
  return `LLM_KEY=${key}\nVLLM_API_KEY=${key}\nHF_HOME=${home}/${SERVICE_DIR}/hf\n`;
}

/** The tunnel's entry in main-host's authorized keys: port forwarding and nothing else, one listen
 * address, and no shell. */
export function authorizedLine(publicKey: string): string {
  return `restrict,port-forwarding,permitlisten="${TUNNEL_LISTEN}",command="/usr/sbin/nologin" ${publicKey}`;
}

/** The key's type and body, without its comment: what two lines naming the same key share. */
export function keyMaterial(publicKey: string): string | null {
  const match = /(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+)\s+([A-Za-z0-9+/=]+)/.exec(publicKey);
  return match === null ? null : `${match[1]} ${match[2]}`;
}

/** Adds the tunnel's entry unless the same key already stands there, whatever its options. */
export function ensureAuthorized(path: string, publicKey: string): "added" | "already there" | string {
  const material = keyMaterial(publicKey);
  if (material === null) {
    return "터널 공개키를 읽지 못했어요";
  }

  const standing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (standing.split("\n").some((line) => keyMaterial(line) === material)) {
    return "already there";
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lead = standing === "" || standing.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${lead}${authorizedLine(material)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);

  return "added";
}

/** main-host's own host key as the line the node pins it by. */
export function knownHostsLine(hostKeyText: string): string | null {
  const material = keyMaterial(hostKeyText);
  return material === null ? null : `${TUNNEL_ALIAS} ${material}`;
}

/** The bridge unit linked from the checkout, read again, and started — restarted where it already ran,
 * so an update takes effect. */
export function bridgeCommand(checkout: string): string {
  const runtime = "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";
  return `${runtime} && mkdir -p ~/.config/systemd/user && ln -sfn ${checkout}/${BRIDGE_UNIT} ~/.config/systemd/user/${BRIDGE_UNIT}`
    + ` && systemctl --user daemon-reload && systemctl --user enable ${BRIDGE_UNIT} && systemctl --user restart ${BRIDGE_UNIT}`;
}

export function makeDirsCommand(): string {
  return `mkdir -p ~/${SERVICE_DIR} ~/${CONFIG_DIR} && chmod 700 ~/${CONFIG_DIR}`;
}

export function envModeCommand(): string {
  return `chmod 600 ~/${CONFIG_DIR}/env`;
}

/** The setup, started and let go of: the hub stops a command it streams after five minutes, and the
 * stop reaches the whole process group, so it is detached and read back out of its log. */
export function setupLaunchCommand(): string {
  return `cd ~/${SERVICE_DIR} && chmod +x node-setup.sh && rm -f setup.log && `
    + `setsid nohup bash node-setup.sh > setup.log 2>&1 < /dev/null & echo launched`;
}

export function setupTailCommand(lines = 40): string {
  return `tail -n ${lines} ~/${SERVICE_DIR}/setup.log 2>/dev/null || true`;
}

export interface SetupEnd {
  done: boolean;
  ok: boolean;
  fault: string | null;
}

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

/** Makes the tunnel's key once and says only its public half. */
export function tunnelKeyCommand(node: string): string {
  const key = `~/${TUNNEL_KEY}`;
  return `test -f ${key} || ssh-keygen -q -t ed25519 -N '' -C bmo-llm-tunnel@${node} -f ${key} && chmod 600 ${key} && cat ${key}.pub`;
}

/** The units put where the user manager reads them, read again, and started — restarted where they
 * already ran, so an update takes effect. */
export function unitsCommand(): string {
  const runtime = "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";
  const units = UNITS.join(" ");
  return `${runtime} && mkdir -p ~/.config/systemd/user && `
    + UNITS.map((unit) => `cp ~/${SERVICE_DIR}/${unit} ~/.config/systemd/user/${unit}`).join(" && ")
    + ` && systemctl --user daemon-reload && systemctl --user enable ${units} && systemctl --user restart ${units}`;
}

async function answersHealth(): Promise<boolean> {
  try {
    return (await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) })).status === 200;
  } catch {
    return false;
  }
}

/** The whole install, one step after another, stopping at the first that fails and saying which. */
export async function installLlmService(options: InstallOptions): Promise<InstallOutcome> {
  const node = options.node ?? LLM_NODE;
  const folder = options.folder ?? join(sourceRoot(), "llm-server");
  const say = options.say ?? (() => {});
  const wait = options.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  const done: InstallStep[] = [];
  const stop = (step: InstallStep, fault: string): InstallOutcome => ({ ok: false, step, fault, done });
  const { exec, upload } = nodeCalls(options.runner, options.console, node);

  // 1. The key, on main-host.
  const keyed = ensureKey(options.keyPath ?? serviceKeyPath());
  if (typeof keyed === "string") {
    return stop("key", keyed);
  }
  say(keyed.made ? "서비스 키를 새로 만들었어요" : "서비스 키는 이미 있어요");
  done.push("key");

  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);
  if (home === null) {
    return stop("home", `${node} 가 답하지 않아요 — ${runFault(asked)}`);
  }
  const made = await exec(makeDirsCommand());
  if (made.code !== 0) {
    return stop("home", `폴더를 만들지 못했어요 — ${runFault(made)}`);
  }
  done.push("home");

  // 2. The environment file, made privately here and carried across whole. The folder it lands in is
  // the account's alone before the file arrives.
  const scratch = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "bmo-llm-env-"));
  try {
    const envPath = join(scratch, "env");
    writeFileSync(envPath, envFileText(keyed.key, home), { mode: 0o600 });
    const carried = await upload(envPath, `${home}/${CONFIG_DIR}/env`);
    if (carried.code !== 0) {
      return stop("env", `환경 파일을 올리지 못했어요 — ${runFault(carried)}`);
    }
    const moded = await exec(envModeCommand());
    if (moded.code !== 0) {
      return stop("env", `환경 파일 권한을 맞추지 못했어요 — ${runFault(moded)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  done.push("env");

  // 3. The service's files.
  for (const name of SERVICE_FILES) {
    const carried = await upload(join(folder, name), `${home}/${SERVICE_DIR}/${name}`);
    if (carried.code !== 0) {
      return stop("upload", `${name} 를 올리지 못했어요 — ${runFault(carried)}`);
    }
  }
  say(`${node}: 서비스 파일 ${SERVICE_FILES.length}개를 올렸어요`);
  done.push("upload");

  // 4. The setup, detached and waited on.
  say(`${node}: vLLM 과 모델을 세우는 중`);
  const launched = await exec(setupLaunchCommand());
  if (launched.code !== 0) {
    return stop("setup", `설치를 시작하지 못했어요 — ${runFault(launched)}`);
  }
  let end: SetupEnd = { done: false, ok: false, fault: null };
  for (let poll = 0; poll < (options.setupPolls ?? 160) && !end.done; poll += 1) {
    await wait(options.setupEveryMs ?? 15_000);
    end = parseSetupEnd((await exec(setupTailCommand())).stdout);
  }
  if (!end.done) {
    return stop("setup", `설치가 끝나지 않았어요 — ~/${SERVICE_DIR}/setup.log 를 보세요`);
  }
  if (!end.ok) {
    return stop("setup", `설치가 ${end.fault} 단계에서 멈췄어요 — ~/${SERVICE_DIR}/setup.log 를 보세요`);
  }
  done.push("setup");

  // 5. The tunnel's key, made on the node; only its public half comes back.
  const keyAnswer = await exec(tunnelKeyCommand(node));
  const publicKey = keyAnswer.stdout.split("\n").map((line) => line.trim()).find((line) => keyMaterial(line) !== null);
  if (keyAnswer.code !== 0 || publicKey === undefined) {
    return stop("tunnel-key", `터널 키를 만들지 못했어요 — ${runFault(keyAnswer)}`);
  }
  done.push("tunnel-key");

  // 6. Its entry on main-host.
  const authorized = ensureAuthorized(options.authorizedKeysPath ?? join(homeDir(), ".ssh", "authorized_keys"), publicKey);
  if (authorized !== "added" && authorized !== "already there") {
    return stop("authorized-keys", authorized);
  }
  say(authorized === "added" ? "main-host 에 터널 키를 들였어요" : "main-host 에 터널 키가 이미 있어요");
  done.push("authorized-keys");

  // 7. The tunnel's door on main-host.
  const bridged = await (options.local ?? spawnRunner)(["bash", "-c", bridgeCommand(options.checkout ?? sourceRoot())]);
  if (bridged.code !== 0) {
    return stop("bridge", `${BRIDGE_UNIT} 를 세우지 못했어요 — ${runFault(bridged)}`);
  }
  say(`main-host 에 ${BRIDGE_UNIT} 를 세웠어요`);
  done.push("bridge");

  // 8. main-host's host key, pinned on the node.
  const hostKeyPath = options.hostKeyPath ?? "/etc/ssh/ssh_host_ed25519_key.pub";
  const pinned = existsSync(hostKeyPath) ? knownHostsLine(readFileSync(hostKeyPath, "utf8")) : null;
  if (pinned === null) {
    return stop("known-hosts", `${hostKeyPath} 에서 호스트 키를 읽지 못했어요`);
  }
  const hostScratch = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "bmo-llm-hosts-"));
  try {
    const hostsPath = join(hostScratch, "known_hosts");
    writeFileSync(hostsPath, `${pinned}\n`, { mode: 0o600 });
    const carried = await upload(hostsPath, `${home}/${CONFIG_DIR}/known_hosts`);
    if (carried.code !== 0) {
      return stop("known-hosts", `known_hosts 를 올리지 못했어요 — ${runFault(carried)}`);
    }
  } finally {
    rmSync(hostScratch, { recursive: true, force: true });
  }
  done.push("known-hosts");

  // 9. The units.
  const started = await exec(unitsCommand());
  if (started.code !== 0) {
    return stop("units", `유닛을 올리지 못했어요 — ${runFault(started)}`);
  }
  done.push("units");

  // 10. The service answering on main-host, through the tunnel.
  say(`${HEALTH_URL} 를 기다리는 중`);
  const health = options.health ?? answersHealth;
  let up = await health();
  for (let poll = 0; poll < (options.healthPolls ?? 120) && !up; poll += 1) {
    await wait(options.healthEveryMs ?? 5_000);
    up = await health();
  }
  if (!up) {
    return stop("health", `${HEALTH_URL} 가 답하지 않아요 — ${node} 의 journalctl --user -u bmo-llm-vllm 을 보세요`);
  }
  done.push("health");

  return { ok: true, step: null, fault: null, done };
}
