import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault } from "./node-calls";
import { dataPath, homeDir, repositoryRoot } from "./roots";
import { settingText } from "./settings";

import type { NodeCalls, NodeRunner } from "./node-calls";

// Putting a service that answers through the tunnel door on a node (docs/llm-server.md, 「Installing and
// updating」). Every such service is installed by the same steps; what it carries, what it calls its
// folders and units, and where it listens on the operations machine are its own, and it answers them as a
// TunnelledService. The node is reached through the calls its caller hands over, the node console by the
// node's name where none are; the operations machine's end — the key, the tunnel's authorized entry and
// the door's list — is written here on this machine. Each step leaves alone what already stands, so an install is run again to
// update as often as one likes.
//
// A service key is read or made here, carried to the node only inside a file, and never written into
// a command, an answer or a line said aloud.

/** What one tunnelled service is made of: the answers the shared install asks it for. */
export interface TunnelledService {
  /** The node it stands on. */
  node: string;
  /** The node's folder for the service's files and its setup's log. */
  serviceDir: string;
  /** The node's folder for its settings and secrets, private to the account. */
  configDir: string;
  /** Where its key stands on the operations machine. */
  keyPath(): string;
  /** The node's settings file, carrying the key. */
  envFileText(key: string): string;
  /** The folders it needs on the node, and anything made there once. */
  makeDirsCommand(): string;
  /** What goes across, as [local, remote] pairs, from the repository to the node's home. */
  carried(checkout: string, home: string): Array<[string, string]>;
  /** What its setup says first on its last line. */
  setupDone: string;
  /** Its units, in the order they are started. */
  units: readonly string[];
  /** Units of its own that must not run on this node, stopped and disabled where they stand. */
  unitsAbsent?: readonly string[];
  /** The one address its tunnel may listen on at the operations machine. */
  listen: string;
  /** The unit whose journal says why it does not answer. */
  engineUnit: string;
  /** What the install says the service is called. */
  label: string;
}

/** Where a node's tunnel dials and whom it logs in as: the tunnel's public name, the login on the operations
 * machine, and the name the operations machine's host key is pinned under on every node, as the tooling's
 * settings name them (docs/llm-server.md, 「The tunnel」). */
export interface TunnelEnds {
  url: string;
  login: string;
  host: string;
}

export function tunnelEnds(): TunnelEnds {
  return { url: settingText("tunnel_url"), login: settingText("tunnel_login"), host: settingText("tunnel_host") };
}

/** The lines of a node's environment file the tunnel unit reads beside the service's own listen. */
export function tunnelLines(tunnel: TunnelEnds): string {
  return `TUNNEL_URL=${tunnel.url}\nTUNNEL_LOGIN=${tunnel.login}\nTUNNEL_HOST=${tunnel.host}\n`;
}

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
  | "machine" | "lend" | "key" | "home" | "env" | "upload" | "setup" | "tunnel-key" | "authorized-keys" | "door" | "known-hosts" | "units" | "health";

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
  /** How the node is reached; through the node console by the node's name where not given. */
  calls?: NodeCalls;
  /** The repository the files are carried from; this one by default. */
  checkout?: string;
  console: string;
  /** Where the tunnel dials; the settings' by default. */
  tunnel?: TunnelEnds;
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
      return `${path} is not at 0600 (${mode.toString(8)})`;
    }
    const key = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(key) ? { key, made: false } : `${path} is not a service key`;
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  // Exclusive, so two installs at once cannot write two keys over each other.
  writeFileSync(path, `${key}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);

  return { key, made: true };
}

/** A tunnel's entry in the operations machine's authorized keys: port forwarding and nothing else, one listen
 * address, and no shell. */
export function authorizedLine(publicKey: string, listen: string): string {
  return `restrict,port-forwarding,permitlisten="${listen}",command="/usr/sbin/nologin" ${publicKey}`;
}

/** The key's type and body, without its comment or options: what two lines naming the same key share. An
 * authorized-keys line is matched here by its key alone, which no library the runtime carries reads out of
 * one; OpenSSH's own reading answers a fingerprint rather than the material a line is rewritten by. */
export function keyMaterial(publicKey: string): string | null {
  const match = /(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+)\s+([A-Za-z0-9+/=]+)/.exec(publicKey);
  return match === null ? null : `${match[1]} ${match[2]}`;
}

/** Adds a tunnel's entry, or rewrites the entry of the same key where it says anything else, so the
 * key may listen on the one address its service names now. */
export function ensureAuthorized(path: string, publicKey: string, listen: string): "added" | "already there" | "rewritten" | string {
  const material = keyMaterial(publicKey);
  if (material === null) {
    return "the tunnel's public key could not be read";
  }

  const standing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const wanted = authorizedLine(material, listen);
  const lines = standing.split("\n");
  const at = lines.findIndex((line) => keyMaterial(line) === material);
  if (at !== -1) {
    if (lines[at] === wanted) {
      return "already there";
    }
    lines[at] = wanted;
    writeFileSync(path, lines.join("\n"), { mode: 0o600 });
    chmodSync(path, 0o600);

    return "rewritten";
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lead = standing === "" || standing.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${lead}${wanted}\n`, { mode: 0o600 });
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

/** The operations machine's own host key as the line a node pins it by, under the name the tunnel knows it
 * by. */
export function knownHostsLine(hostKeyText: string, alias: string): string | null {
  const material = keyMaterial(hostKeyText);
  return material === null ? null : `${alias} ${material}`;
}

export function envModeCommand(service: Pick<TunnelledService, "configDir">): string {
  return `chmod 600 ~/${service.configDir}/env`;
}

/** The setup, started and let go of: the hub stops a command it streams after five minutes, and the
 * stop reaches the whole process group, so it is detached and read back out of its log. */
export function setupLaunchCommand(service: Pick<TunnelledService, "serviceDir">): string {
  return `cd ~/${service.serviceDir} && chmod +x node-setup.sh && rm -f setup.log && `
    + `setsid nohup bash node-setup.sh > setup.log 2>&1 < /dev/null & echo launched`;
}

export function setupTailCommand(service: Pick<TunnelledService, "serviceDir">, lines = 40): string {
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
 * already ran, so an update takes effect — and the ones that must not run here stopped and disabled. */
export function unitsCommand(service: Pick<TunnelledService, "serviceDir" | "units" | "unitsAbsent">): string {
  const runtime = "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";
  const units = service.units.join(" ");
  const absent = service.unitsAbsent ?? [];
  const stopped = absent.length === 0
    ? ""
    : ` && { systemctl --user disable --now ${absent.join(" ")} 2>/dev/null; rm -f ${absent.map((unit) => `~/.config/systemd/user/${unit}`).join(" ")}; systemctl --user daemon-reload; }`;
  return `${runtime} && mkdir -p ~/.config/systemd/user && `
    + service.units.map((unit) => `cp ~/${service.serviceDir}/${unit} ~/.config/systemd/user/${unit}`).join(" && ")
    + ` && systemctl --user daemon-reload && systemctl --user enable ${units} && systemctl --user restart ${units}${stopped}`;
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
  const checkout = options.checkout ?? repositoryRoot();
  const tunnel = options.tunnel ?? tunnelEnds();
  const say = options.say ?? (() => {});
  const wait = options.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  const done: InstallStep[] = [];
  const stop = (step: InstallStep, fault: string): InstallOutcome => ({ ok: false, step, fault, done });
  const { exec, upload } = options.calls ?? nodeCalls(options.runner, options.console, node);
  const keyPath = options.keyPath ?? service.keyPath();

  // 1. The key, on the operations machine.
  const keyed = ensureKey(keyPath);
  if (typeof keyed === "string") {
    return stop("key", keyed);
  }
  say(keyed.made ? "the service key was made" : "the service key stands already");
  done.push("key");

  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);
  if (home === null) {
    return stop("home", `${node} does not answer — ${runFault(asked)}`);
  }
  const made = await exec(service.makeDirsCommand());
  if (made.code !== 0) {
    return stop("home", `the folders could not be made — ${runFault(made)}`);
  }
  done.push("home");

  // 2. The settings file, the service's own lines and the tunnel's, made privately here and carried across whole. The folder it lands in is the
  // account's alone before the file arrives.
  const scratch = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `${service.serviceDir}-env-`));
  try {
    const envPath = join(scratch, "env");
    writeFileSync(envPath, service.envFileText(keyed.key) + tunnelLines(tunnel), { mode: 0o600 });
    const carried = await upload(envPath, `${home}/${service.configDir}/env`);
    if (carried.code !== 0) {
      return stop("env", `the environment file could not be put across — ${runFault(carried)}`);
    }
    const moded = await exec(envModeCommand(service));
    if (moded.code !== 0) {
      return stop("env", `the environment file's mode could not be set — ${runFault(moded)}`);
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
      return stop("upload", `${local} could not be put across — ${runFault(carried)}`);
    }
  }
  say(`${node}: ${carrying.length} service files put across`);
  done.push("upload");

  // 4. The setup, detached and waited on.
  say(`${node}: standing up the environment of ${service.label}`);
  const launched = await exec(setupLaunchCommand(service));
  if (launched.code !== 0) {
    return stop("setup", `the install could not be started — ${runFault(launched)}`);
  }
  let end: SetupEnd = { done: false, ok: false, fault: null };
  for (let poll = 0; poll < (options.setupPolls ?? 160) && !end.done; poll += 1) {
    await wait(options.setupEveryMs ?? 15_000);
    end = parseSetupEnd((await exec(setupTailCommand(service))).stdout, service.setupDone);
  }
  if (!end.done) {
    return stop("setup", `the install did not finish — see ~/${service.serviceDir}/setup.log`);
  }
  if (!end.ok) {
    return stop("setup", `the install stopped at its ${end.fault} step — see ~/${service.serviceDir}/setup.log`);
  }
  done.push("setup");

  // 5. The tunnel's key, made on the node; only its public half comes back.
  const keyAnswer = await exec(tunnelKeyCommand(service));
  const publicKey = keyAnswer.stdout.split("\n").map((line) => line.trim()).find((line) => keyMaterial(line) !== null);
  if (keyAnswer.code !== 0 || publicKey === undefined) {
    return stop("tunnel-key", `the tunnel key could not be made — ${runFault(keyAnswer)}`);
  }
  done.push("tunnel-key");

  // 6. Its entry on the operations machine.
  const authorized = ensureAuthorized(options.authorizedKeysPath ?? join(homeDir(), ".ssh", "authorized_keys"), publicKey, service.listen);
  if (authorized !== "added" && authorized !== "already there" && authorized !== "rewritten") {
    return stop("authorized-keys", authorized);
  }
  say({
    added: "the tunnel key was let in on the operations machine",
    rewritten: `the tunnel key on the operations machine was set to listen on ${service.listen} alone`,
    "already there": "the tunnel key stands on the operations machine already",
  }[authorized]);
  done.push("authorized-keys");

  // 7. The key named in the door's list, which the door reads for each connection, so the door itself
  // is left as it stands: it is the node unit's.
  const listed = ensureDoorKey(options.doorListPath ?? doorListPath(), keyPath);
  say(listed === "added" ? "the key was named in the door's list" : "the key stands in the door's list already");
  done.push("door");

  // 8. The operations machine's host key, pinned on the node.
  const hostKeyPath = options.hostKeyPath ?? "/etc/ssh/ssh_host_ed25519_key.pub";
  const pinned = existsSync(hostKeyPath) ? knownHostsLine(readFileSync(hostKeyPath, "utf8"), tunnel.host) : null;
  if (pinned === null) {
    return stop("known-hosts", `no host key could be read from ${hostKeyPath}`);
  }
  const hostScratch = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `${service.serviceDir}-hosts-`));
  try {
    const hostsPath = join(hostScratch, "known_hosts");
    writeFileSync(hostsPath, `${pinned}\n`, { mode: 0o600 });
    const carried = await upload(hostsPath, `${home}/${service.configDir}/known_hosts`);
    if (carried.code !== 0) {
      return stop("known-hosts", `known_hosts could not be put across — ${runFault(carried)}`);
    }
  } finally {
    rmSync(hostScratch, { recursive: true, force: true });
  }
  done.push("known-hosts");

  // 9. The units.
  const started = await exec(unitsCommand(service));
  if (started.code !== 0) {
    return stop("units", `the units could not be stood up — ${runFault(started)}`);
  }
  done.push("units");

  // 10. The service answering on the operations machine, through the tunnel.
  const url = healthUrl(service);
  say(`waiting for ${url}`);
  const health = options.health ?? answersHealth(url);
  let up = await health();
  for (let poll = 0; poll < (options.healthPolls ?? 120) && !up; poll += 1) {
    await wait(options.healthEveryMs ?? 5_000);
    up = await health();
  }
  if (!up) {
    return stop("health", `${url} does not answer — see journalctl --user -u ${service.engineUnit} on ${node}`);
  }
  done.push("health");

  return { ok: true, step: null, fault: null, done };
}
