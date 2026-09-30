import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault, spawnRunner } from "./jake";
import { dataPath, homeDir, sourceRoot } from "./roots";

import type { NodeRunner } from "./jake";

// Putting a service that answers through the tunnel door on a jake node (docs/llm-server.md,
// 「Installing and updating」, and docs/n5-llm.md). Every such service is installed by the same steps;
// what it carries, what it calls its folders and units, and where it listens on main-host are its own,
// and it answers them as a TunnelledService. The node is reached only through the jake console; the
// main-host end — the key, the tunnel's authorized entry, the door's list and the bridge — is written
// here on this machine. Each step leaves alone what already stands, so an install is run again to
// update as often as one likes.
//
// A service key is read or made here, carried to the node only inside a file, and never written into
// a command, an answer or a line said aloud.

/** What one tunnelled service is made of: the answers the shared install asks it for. */
export interface TunnelledService {
  /** The jake node it stands on. */
  node: string;
  /** The node's folder for the service's files and its setup's log. */
  serviceDir: string;
  /** The node's folder for its settings and secrets, private to the account. */
  configDir: string;
  /** Where its key stands on main-host. */
  keyPath(): string;
  /** The node's settings file, carrying the key. */
  envFileText(key: string): string;
  /** The folders it needs on the node, and anything made there once. */
  makeDirsCommand(): string;
  /** What goes across, as [local, remote] pairs, from the checkout to the node's home. */
  carried(checkout: string, home: string): Array<[string, string]>;
  /** What its setup says first on its last line. */
  setupDone: string;
  /** Its units, in the order they are started. */
  units: readonly string[];
  /** The one address its tunnel may listen on at main-host. */
  listen: string;
  /** The unit whose journal says why it does not answer. */
  engineUnit: string;
  /** What the install says the service is called. */
  label: string;
}

/** The tunnel's door on main-host, a unit of this checkout linked where the user manager reads it. */
export const BRIDGE_UNIT = "bmo-llm-bridge.service";

/** The name main-host's host key is pinned under on every node. */
export const TUNNEL_ALIAS = "main-host";

/** The door's list: one key file's path to a line, each a service that rides the door. */
export function doorListPath(): string {
  return dataPath("env", "tunnel-door.keys");
}

export function healthUrl(service: TunnelledService): string {
  return `http://${service.listen}/health`;
}

export function tunnelKeyPath(service: TunnelledService): string {
  return `${service.configDir}/tunnel_ed25519`;
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
  /** The checkout the files are carried from and the bridge unit is linked from. */
  checkout?: string;
  console: string;
  keyPath?: string;
  doorListPath?: string;
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

/** A service key: read where it stands, made once where it does not. A key found with any permission
 * but 0600 is refused rather than used, since it may already have been read. */
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

/** A tunnel's entry in main-host's authorized keys: port forwarding and nothing else, one listen
 * address, and no shell. */
export function authorizedLine(publicKey: string, listen: string): string {
  return `restrict,port-forwarding,permitlisten="${listen}",command="/usr/sbin/nologin" ${publicKey}`;
}

/** The key's type and body, without its comment: what two lines naming the same key share. */
export function keyMaterial(publicKey: string): string | null {
  const match = /(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+)\s+([A-Za-z0-9+/=]+)/.exec(publicKey);
  return match === null ? null : `${match[1]} ${match[2]}`;
}

/** Adds a tunnel's entry unless the same key already stands there, whatever its options. */
export function ensureAuthorized(path: string, publicKey: string, listen: string): "added" | "already there" | string {
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
  appendFileSync(path, `${lead}${authorizedLine(material, listen)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);

  return "added";
}

/** Names a service's key file in the door's list unless it is already there. */
export function ensureDoorKey(listPath: string, keyPath: string): "added" | "already there" {
  const standing = existsSync(listPath) ? readFileSync(listPath, "utf8") : "";
  if (standing.split("\n").some((line) => line.trim() === keyPath)) {
    return "already there";
  }

  mkdirSync(dirname(listPath), { recursive: true, mode: 0o700 });
  const lead = standing === "" || standing.endsWith("\n") ? "" : "\n";
  appendFileSync(listPath, `${lead}${keyPath}\n`, { mode: 0o600 });

  return "added";
}

/** main-host's own host key as the line a node pins it by. */
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

export function envModeCommand(service: TunnelledService): string {
  return `chmod 600 ~/${service.configDir}/env`;
}

/** The setup, started and let go of: the hub stops a command it streams after five minutes, and the
 * stop reaches the whole process group, so it is detached and read back out of its log. */
export function setupLaunchCommand(service: TunnelledService): string {
  return `cd ~/${service.serviceDir} && chmod +x node-setup.sh && rm -f setup.log && `
    + `setsid nohup bash node-setup.sh > setup.log 2>&1 < /dev/null & echo launched`;
}

export function setupTailCommand(service: TunnelledService, lines = 40): string {
  return `tail -n ${lines} ~/${service.serviceDir}/setup.log 2>/dev/null || true`;
}

export interface SetupEnd {
  done: boolean;
  ok: boolean;
  fault: string | null;
}

export function parseSetupEnd(text: string, marker: string): SetupEnd {
  const line = text.split("\n").map((one) => one.trim()).filter((one) => one.startsWith(marker)).at(-1);
  if (line === undefined) {
    return { done: false, ok: false, fault: null };
  }
  const said = line.slice(marker.length).trim();
  if (said === "ok") {
    return { done: true, ok: true, fault: null };
  }
  return { done: true, ok: false, fault: said.startsWith("failed:") ? said.slice("failed:".length) : said };
}

/** Makes a tunnel's key once and says only its public half. */
export function tunnelKeyCommand(service: TunnelledService): string {
  const key = `~/${tunnelKeyPath(service)}`;
  return `test -f ${key} || ssh-keygen -q -t ed25519 -N '' -C ${service.serviceDir}-tunnel@${service.node} -f ${key} && chmod 600 ${key} && cat ${key}.pub`;
}

/** The units put where the user manager reads them, read again, and started — restarted where they
 * already ran, so an update takes effect. */
export function unitsCommand(service: TunnelledService): string {
  const runtime = "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";
  const units = service.units.join(" ");
  return `${runtime} && mkdir -p ~/.config/systemd/user && `
    + service.units.map((unit) => `cp ~/${service.serviceDir}/${unit} ~/.config/systemd/user/${unit}`).join(" && ")
    + ` && systemctl --user daemon-reload && systemctl --user enable ${units} && systemctl --user restart ${units}`;
}

function answersHealth(url: string): () => Promise<boolean> {
  return async () => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).status === 200;
    } catch {
      return false;
    }
  };
}

/** The whole install, one step after another, stopping at the first that fails and saying which. */
export async function installTunnelledService(service: TunnelledService, options: InstallOptions): Promise<InstallOutcome> {
  const node = service.node;
  const checkout = options.checkout ?? sourceRoot();
  const say = options.say ?? (() => {});
  const wait = options.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  const done: InstallStep[] = [];
  const stop = (step: InstallStep, fault: string): InstallOutcome => ({ ok: false, step, fault, done });
  const { exec, upload } = nodeCalls(options.runner, options.console, node);
  const keyPath = options.keyPath ?? service.keyPath();

  // 1. The key, on main-host.
  const keyed = ensureKey(keyPath);
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
  const made = await exec(service.makeDirsCommand());
  if (made.code !== 0) {
    return stop("home", `폴더를 만들지 못했어요 — ${runFault(made)}`);
  }
  done.push("home");

  // 2. The settings file, made privately here and carried across whole. The folder it lands in is the
  // account's alone before the file arrives.
  const scratch = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `${service.serviceDir}-env-`));
  try {
    const envPath = join(scratch, "env");
    writeFileSync(envPath, service.envFileText(keyed.key), { mode: 0o600 });
    const carried = await upload(envPath, `${home}/${service.configDir}/env`);
    if (carried.code !== 0) {
      return stop("env", `환경 파일을 올리지 못했어요 — ${runFault(carried)}`);
    }
    const moded = await exec(envModeCommand(service));
    if (moded.code !== 0) {
      return stop("env", `환경 파일 권한을 맞추지 못했어요 — ${runFault(moded)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  done.push("env");

  // 3. The service's files.
  const carrying = service.carried(checkout, home);
  for (const [local, remote] of carrying) {
    const carried = await upload(local, remote);
    if (carried.code !== 0) {
      return stop("upload", `${local} 를 올리지 못했어요 — ${runFault(carried)}`);
    }
  }
  say(`${node}: 서비스 파일 ${carrying.length}개를 올렸어요`);
  done.push("upload");

  // 4. The setup, detached and waited on.
  say(`${node}: ${service.label}의 환경을 세우는 중`);
  const launched = await exec(setupLaunchCommand(service));
  if (launched.code !== 0) {
    return stop("setup", `설치를 시작하지 못했어요 — ${runFault(launched)}`);
  }
  let end: SetupEnd = { done: false, ok: false, fault: null };
  for (let poll = 0; poll < (options.setupPolls ?? 160) && !end.done; poll += 1) {
    await wait(options.setupEveryMs ?? 15_000);
    end = parseSetupEnd((await exec(setupTailCommand(service))).stdout, service.setupDone);
  }
  if (!end.done) {
    return stop("setup", `설치가 끝나지 않았어요 — ~/${service.serviceDir}/setup.log 를 보세요`);
  }
  if (!end.ok) {
    return stop("setup", `설치가 ${end.fault} 단계에서 멈췄어요 — ~/${service.serviceDir}/setup.log 를 보세요`);
  }
  done.push("setup");

  // 5. The tunnel's key, made on the node; only its public half comes back.
  const keyAnswer = await exec(tunnelKeyCommand(service));
  const publicKey = keyAnswer.stdout.split("\n").map((line) => line.trim()).find((line) => keyMaterial(line) !== null);
  if (keyAnswer.code !== 0 || publicKey === undefined) {
    return stop("tunnel-key", `터널 키를 만들지 못했어요 — ${runFault(keyAnswer)}`);
  }
  done.push("tunnel-key");

  // 6. Its entry on main-host.
  const authorized = ensureAuthorized(options.authorizedKeysPath ?? join(homeDir(), ".ssh", "authorized_keys"), publicKey, service.listen);
  if (authorized !== "added" && authorized !== "already there") {
    return stop("authorized-keys", authorized);
  }
  say(authorized === "added" ? "main-host 에 터널 키를 들였어요" : "main-host 에 터널 키가 이미 있어요");
  done.push("authorized-keys");

  // 7. The key named in the door's list, and the door on main-host.
  ensureDoorKey(options.doorListPath ?? doorListPath(), keyPath);
  const bridged = await (options.local ?? spawnRunner)(["bash", "-c", bridgeCommand(checkout)]);
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
  const hostScratch = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `${service.serviceDir}-hosts-`));
  try {
    const hostsPath = join(hostScratch, "known_hosts");
    writeFileSync(hostsPath, `${pinned}\n`, { mode: 0o600 });
    const carried = await upload(hostsPath, `${home}/${service.configDir}/known_hosts`);
    if (carried.code !== 0) {
      return stop("known-hosts", `known_hosts 를 올리지 못했어요 — ${runFault(carried)}`);
    }
  } finally {
    rmSync(hostScratch, { recursive: true, force: true });
  }
  done.push("known-hosts");

  // 9. The units.
  const started = await exec(unitsCommand(service));
  if (started.code !== 0) {
    return stop("units", `유닛을 올리지 못했어요 — ${runFault(started)}`);
  }
  done.push("units");

  // 10. The service answering on main-host, through the tunnel.
  const url = healthUrl(service);
  say(`${url} 를 기다리는 중`);
  const health = options.health ?? answersHealth(url);
  let up = await health();
  for (let poll = 0; poll < (options.healthPolls ?? 120) && !up; poll += 1) {
    await wait(options.healthEveryMs ?? 5_000);
    up = await health();
  }
  if (!up) {
    return stop("health", `${url} 가 답하지 않아요 — ${node} 의 journalctl --user -u ${service.engineUnit} 를 보세요`);
  }
  done.push("health");

  return { ok: true, step: null, fault: null, done };
}
