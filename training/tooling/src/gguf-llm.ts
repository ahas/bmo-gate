import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { nodeCalls, runFault } from "./node-calls";
import { reservedAgainst } from "./node-reach";
import { dataPath, homeDir, repositoryRoot } from "./roots";
import {
  authorizedLine, doorListPath, installTunnelledService, knownHostsLine, removeAuthorized, removeDoorKey, tunnelEnds, tunnelLines,
} from "./tunnel-install";

import type { NodeCalls, NodeRunner } from "./node-calls";
import type { InstallOptions, InstallOutcome, TunnelEnds, TunnelledService } from "./tunnel-install";

// A GGUF model stood up on a node by llama.cpp's server, reached through the tunnel door at a loopback
// address of its own on the operations machine (docs/gguf-llm.md). The model file is the catalogue entry's,
// read through the catalogue's own verb; where it stands, which node it stands on, where its tunnel lands
// and how the engine serves it are the registration's in the installer's settings; the units are the
// templates under `runtime/gguf-llm/`, filled with those values. Nothing here names a model, a node or an
// address.

/** The engine's own name: the catalogue entry's engine, the installer's name and the service a node's row
 * may reserve the node for. */
export const ENGINE = "gguf-llm";

/** What the node setup says first on its last line. */
export const SETUP_DONE = "GGUF-LLM-SETUP-DONE";

/** The settings file's name under the data root's `env/`. */
export const SETTINGS_FILE = "gguf-llm.toml";

/** A settings file or a catalogue entry the installer cannot stand a model up from. */
export class GgufRefused extends Error {}

/** What a node runs the engine and the tunnel's dial with: paths under the account's home. */
export interface NodeTools {
  llamaServer: string;
  dialPython: string;
  dialScript: string;
}

/** How one registration is served: the instance's name, which its folders, units and key are called by,
 * its node, where its tunnel lands on the operations machine, the engine's port on the node's loopback
 * and the engine's settings. */
export interface Serving {
  registration: string;
  name: string;
  node: string;
  listen: string;
  port: number;
  context: number;
  parallel: number;
  /** The tokens each slot is held to in the one store the slots share; null where the slots are not held. */
  slotContext: number | null;
  cacheType: string;
  gpuLayers: number;
  flashAttn: string;
  /** The server's further arguments: the chat template, the engine's own sampling defaults and the like. */
  flags: string[];
}

export interface GgufSettings {
  /** The catalogue's verb as a list of words: one entry printed, a node recorded. */
  catalogue: string[];
  nodes: Record<string, NodeTools>;
  registrations: Record<string, Serving>;
}

/** A catalogue entry as the installer reads it. */
export interface CatalogueEntry {
  name: string;
  label: string;
  file: string;
  bytes: number;
  sha256: string;
  /** The `https` address it is fetched from, or null where the file must already stand on the node. */
  source: string | null;
  engine: string | null;
  registration: string | null;
}

/** One entry served on its node: the entry, the registration's serving and the node's tools. */
export interface GgufInstance {
  entry: CatalogueEntry;
  serving: Serving;
  tools: NodeTools;
}

const MODEL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const NODE = /^[a-z0-9][a-z0-9-]*$/;
const LOOPBACK_LISTEN = /^127\.0\.0\.1:(\d{1,5})$/;
// A word a unit carries as it stands: no whitespace, no quote, and neither systemd's specifier nor its
// variable mark.
const WORD = /^[A-Za-z0-9._:=,+/-]+$/;
const HOME_PATH = /^[A-Za-z0-9._/-]+$/;

export function settingsFilePath(): string {
  return dataPath("env", SETTINGS_FILE);
}

function tableAt(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GgufRefused(`${where} is not a table`);
  }

  return value as Record<string, unknown>;
}

function textOf(value: unknown, where: string, shape: RegExp, said: string): string {
  if (typeof value !== "string" || !shape.test(value)) {
    throw new GgufRefused(`${where} is not ${said}`);
  }

  return value;
}

function wholeOf(value: unknown, where: string, least: number, most = Number.MAX_SAFE_INTEGER): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < least || number > most) {
    throw new GgufRefused(`${where} is not a whole number from ${least} to ${most}`);
  }

  return number;
}

function homePathOf(value: unknown, where: string): string {
  const path = textOf(value, where, HOME_PATH, "a path under the account's home");
  if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new GgufRefused(`${where} is not a path under the account's home`);
  }

  return path;
}

function wordsOf(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GgufRefused(`${where} is not a list of words`);
  }

  return value.map((word, at) => textOf(word, `${where}[${at}]`, WORD, "one word a unit carries as it stands"));
}

function servingOf(registration: string, value: unknown, where: string): Serving {
  const table = tableAt(value, where);
  const listen = textOf(table.listen, `${where}.listen`, LOOPBACK_LISTEN, "of the shape 127.0.0.1:<port>");
  wholeOf(Number(LOOPBACK_LISTEN.exec(listen)?.[1]), `${where}.listen's port`, 1024, 65535);

  return {
    registration,
    name: textOf(table.name, `${where}.name`, NAME, "a lowercase name of letters, digits and hyphens"),
    node: textOf(table.node, `${where}.node`, NODE, "a registered node's name"),
    listen,
    port: wholeOf(table.port, `${where}.port`, 1024, 65535),
    context: wholeOf(table.context, `${where}.context`, 1),
    parallel: wholeOf(table.parallel, `${where}.parallel`, 1),
    slotContext: table.slot_context === undefined ? null : wholeOf(table.slot_context, `${where}.slot_context`, 1),
    cacheType: textOf(table.cache_type, `${where}.cache_type`, WORD, "one word"),
    gpuLayers: wholeOf(table.gpu_layers, `${where}.gpu_layers`, 0),
    flashAttn: textOf(table.flash_attn, `${where}.flash_attn`, WORD, "one word"),
    flags: wordsOf(table.flags, `${where}.flags`),
  };
}

function distinctBy(servings: readonly Serving[], key: (one: Serving) => string, what: string, path: string): void {
  const seen = new Map<string, string>();
  for (const one of servings) {
    const value = key(one);
    const other = seen.get(value);
    if (other !== undefined) {
      throw new GgufRefused(`${path}: registrations ${other} and ${one.registration} share the ${what} ${value}`);
    }
    seen.set(value, one.registration);
  }
}

/** The installer's settings out of their text, held to their shape (docs/gguf-llm.md, 「The settings」). */
export function parseGgufSettings(text: string, path: string): GgufSettings {
  let read: unknown;
  try {
    read = Bun.TOML.parse(text);
  } catch (cause) {
    throw new GgufRefused(`${path} is not TOML: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const whole = tableAt(read, path);
  const catalogue = whole.catalogue_command;
  if (!Array.isArray(catalogue) || catalogue.length === 0 || !catalogue.every((word) => typeof word === "string" && word !== "")) {
    throw new GgufRefused(`${path} gives no catalogue_command as a list of words`);
  }
  const nodes: Record<string, NodeTools> = {};
  for (const [node, value] of Object.entries(tableAt(whole.nodes ?? {}, `${path} nodes`))) {
    const where = `nodes.${node}`;
    const table = tableAt(value, where);
    nodes[textOf(node, where, NODE, "a registered node's name")] = {
      llamaServer: homePathOf(table.llama_server, `${where}.llama_server`),
      dialPython: homePathOf(table.dial_python, `${where}.dial_python`),
      dialScript: homePathOf(table.dial_script, `${where}.dial_script`),
    };
  }
  const registrations: Record<string, Serving> = {};
  for (const [registration, value] of Object.entries(tableAt(whole.registrations ?? {}, `${path} registrations`))) {
    registrations[textOf(registration, `registrations.${registration}`, NAME, "a registration's name")] =
      servingOf(registration, value, `registrations.${registration}`);
  }
  const servings = Object.values(registrations);
  distinctBy(servings, (one) => one.name, "name", path);
  distinctBy(servings, (one) => one.listen, "listen", path);
  distinctBy(servings, (one) => `${one.node} port ${one.port}`, "engine port on", path);

  return { catalogue: catalogue as string[], nodes, registrations };
}

/** The installer's settings as the data root's file gives them; a missing file is refused, naming it. */
export function readGgufSettings(path: string = settingsFilePath()): GgufSettings {
  if (!existsSync(path)) {
    throw new GgufRefused(`${path} does not stand; the installer's settings are read from it`);
  }

  return parseGgufSettings(readFileSync(path, "utf8"), path);
}

/** A catalogue entry out of the verb's answer, its last line, held to what the installer needs of it. */
export function parseEntry(text: string): CatalogueEntry {
  let read: unknown;
  try {
    read = JSON.parse(text.trim().split("\n").at(-1) ?? "");
  } catch {
    throw new GgufRefused("the catalogue's answer is not an entry");
  }
  const entry = tableAt(read, "the catalogue entry");
  const name = textOf(entry.name, "the entry's name", NAME, "an entry's name");
  const label = typeof entry.label === "string" && entry.label.trim() !== "" ? entry.label.trim() : name;
  if (/[\r\n]/.test(label)) {
    throw new GgufRefused(`${name}'s label is not one line`);
  }
  const source = typeof entry.source === "string" && entry.source.startsWith("https://") ? entry.source : null;
  if (source !== null && !/^https:\/\/[^\s'"\\$`]+$/.test(source)) {
    throw new GgufRefused(`${name}'s source is not an https address a shell carries as it stands`);
  }

  return {
    name,
    label,
    file: textOf(entry.file, `${name}'s file`, MODEL_FILE, "a file name ending in .gguf"),
    bytes: wholeOf(entry.bytes, `${name}'s bytes`, 1),
    sha256: textOf(entry.sha256, `${name}'s sha256`, SHA256, "64 lowercase hexadecimal digits"),
    source,
    engine: typeof entry.engine === "string" ? entry.engine : null,
    registration: typeof entry.registration === "string" ? entry.registration : null,
  };
}

/** The archive the catalogue is read in: the one the choice was made in, as its runner names it. */
function archiveWords(): string[] {
  const archive = process.env.BMO_DB_PATH;

  return archive === undefined || archive === "" ? [] : ["--db", archive];
}

/** The catalogue's verb printing one entry whole. */
export function entryCommand(settings: Pick<GgufSettings, "catalogue">, name: string): string[] {
  return [...settings.catalogue, "--entry", name, "--json", ...archiveWords()];
}

/** The catalogue's verb recording a node the entry's file now lies on. */
export function placedCommand(settings: Pick<GgufSettings, "catalogue">, name: string, node: string): string[] {
  return [...settings.catalogue, "--placed", name, node, ...archiveWords()];
}

export async function readEntry(settings: GgufSettings, name: string, runner: NodeRunner): Promise<CatalogueEntry | string> {
  const asked = await runner(entryCommand(settings, name));
  if (asked.code !== 0) {
    return `the catalogue's ${name} could not be read — ${runFault(asked)}`;
  }
  try {
    return parseEntry(asked.stdout);
  } catch (cause) {
    return cause instanceof GgufRefused ? cause.message : String(cause);
  }
}

/** The entry with the registration's serving and its node's tools, or why it cannot be served here. */
export function instanceOf(entry: CatalogueEntry, settings: GgufSettings, path: string = settingsFilePath()): GgufInstance {
  if (entry.engine !== null && entry.engine !== ENGINE) {
    throw new GgufRefused(`${entry.name} is served by ${entry.engine}, not by ${ENGINE}`);
  }
  if (entry.registration === null) {
    throw new GgufRefused(`${entry.name} names no registration, which is how its engine is reached`);
  }
  const serving = settings.registrations[entry.registration];
  if (serving === undefined) {
    throw new GgufRefused(`${path} gives no [registrations.${entry.registration}], which says where and how ${entry.name} is served`);
  }
  const tools = settings.nodes[serving.node];
  if (tools === undefined) {
    throw new GgufRefused(`${path} gives no [nodes.${serving.node}], which says what ${serving.node} runs the engine and the dial with`);
  }

  return { entry, serving, tools };
}

/** The name the engine serves the file under: its file's name without `.gguf`. */
export function modelName(entry: Pick<CatalogueEntry, "file">): string {
  return entry.file.replace(/\.gguf$/, "");
}

export function configDir(serving: Pick<Serving, "name">): string {
  return `.config/${serving.name}`;
}

export function unitNames(serving: Pick<Serving, "name">): { engine: string; tunnel: string } {
  return { engine: `${serving.name}-engine.service`, tunnel: `${serving.name}-tunnel.service` };
}

/** The instance's key on the operations machine, the engine's key and its tunnel's at the door. */
export function ggufKeyPath(serving: Pick<Serving, "name">): string {
  return dataPath("env", `${serving.name}.token`);
}

/** The address a registration reaches the engine at on the operations machine. */
export function registrationAddress(serving: Pick<Serving, "listen">): string {
  return `http://${serving.listen}/v1/chat/completions`;
}

/** A template filled: every `{{name}}` mark by its value, and a mark with no value refused. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>, where: string): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new GgufRefused(`${where} carries the mark {{${key}}}, which the installer gives no value`);
    }

    return value;
  });
}

/** The values the unit templates are filled with. */
export function templateValues(instance: GgufInstance): Record<string, string> {
  const { entry, serving, tools } = instance;

  return {
    // A unit reads % as the start of a specifier.
    label: entry.label.replaceAll("%", "%%"),
    registration: serving.registration,
    name: serving.name,
    folder: serving.name,
    config: configDir(serving),
    // The word the engine's process declares itself to the node's card arbiter as: the engine's own name, which
    // is the occupant the card master places it as.
    service: ENGINE,
    llama_server: tools.llamaServer,
    dial_python: tools.dialPython,
    dial_script: tools.dialScript,
    port: String(serving.port),
    listen_port: serving.listen.slice(serving.listen.lastIndexOf(":") + 1),
    gpu_layers: String(serving.gpuLayers),
    context: String(serving.context),
    parallel: String(serving.parallel),
    slot_context: serving.slotContext === null ? "" : ` --kv-unified-per-slot ${serving.slotContext}`,
    flash_attn: serving.flashAttn,
    cache_type: serving.cacheType,
    flags: serving.flags.join(" "),
  };
}

export function templatesDir(checkout: string = repositoryRoot()): string {
  return join(checkout, "runtime", "gguf-llm");
}

/** The two units, named and filled. */
export function renderUnits(instance: GgufInstance, checkout: string = repositoryRoot()): Array<[string, string]> {
  const values = templateValues(instance);
  const names = unitNames(instance.serving);

  return (["engine", "tunnel"] as const).map((kind): [string, string] => {
    const path = join(templatesDir(checkout), `${kind}.service`);

    return [names[kind], fillTemplate(readFileSync(path, "utf8"), values, path)];
  });
}

/** What the node setup reads: the model's file, size, hash and source, and the paths it checks. */
export function setupEnvText(instance: GgufInstance): string {
  const { entry, tools } = instance;

  return `MODEL_FILE='${entry.file}'\nMODEL_BYTES='${entry.bytes}'\nMODEL_SHA256='${entry.sha256}'\nMODEL_SOURCE='${entry.source ?? ""}'\n`
    + `LLAMA_SERVER='${tools.llamaServer}'\nDIAL_PYTHON='${tools.dialPython}'\nDIAL_SCRIPT='${tools.dialScript}'\n`;
}

/** What the engine's unit reads: the file it serves and the name it serves it under. */
export function engineEnvText(entry: Pick<CatalogueEntry, "file">): string {
  return `MODEL_FILE=${entry.file}\nMODEL_NAME=${modelName(entry)}\n`;
}

/** The tunnel's own lines of the settings file, before the door's: the key the dial bears and the listen
 * the forward asks for. */
export function envText(serving: Pick<Serving, "listen">, key: string): string {
  return `LLM_KEY=${key}\nLISTEN=${serving.listen}\n`;
}

/** The settings folder's further files: the engine's key file, which holds the key and nothing else, and
 * the engine's own settings. */
export function configFiles(entry: Pick<CatalogueEntry, "file">, key: string): Array<[string, string]> {
  return [["key", key], ["engine.env", engineEnvText(entry)]];
}

export const NODE_SETUP = "node-setup.sh";
export const SETUP_ENV = "setup.env";

/** The instance as the shared tunnelled install reads it, its filled units and setup settings standing in
 * `rendered`. */
export function ggufService(instance: GgufInstance, rendered: string): TunnelledService {
  const { entry, serving } = instance;
  const config = configDir(serving);
  const names = unitNames(serving);

  return {
    node: serving.node,
    serviceDir: serving.name,
    configDir: config,
    keyPath: () => ggufKeyPath(serving),
    envFileText: (key) => envText(serving, key),
    configFiles: (key) => configFiles(entry, key),
    makeDirsCommand: () => `mkdir -p ~/${serving.name}/models ~/${config} && chmod 700 ~/${config}`,
    carried: (checkout, home) => [
      [join(templatesDir(checkout), NODE_SETUP), `${home}/${serving.name}/${NODE_SETUP}`],
      [join(rendered, SETUP_ENV), `${home}/${serving.name}/${SETUP_ENV}`],
      [join(rendered, names.engine), `${home}/${serving.name}/${names.engine}`],
      [join(rendered, names.tunnel), `${home}/${serving.name}/${names.tunnel}`],
    ],
    setupDone: SETUP_DONE,
    units: [names.engine, names.tunnel],
    listen: serving.listen,
    engineUnit: names.engine.replace(/\.service$/, ""),
    label: `${entry.label} on ${serving.node}`,
  };
}

/** The units and the setup's settings written into a folder, for the install to carry across. */
export function writeRendered(instance: GgufInstance, folder: string, checkout?: string): void {
  for (const [name, text] of renderUnits(instance, checkout)) {
    writeFileSync(join(folder, name), text);
  }
  writeFileSync(join(folder, SETUP_ENV), setupEnvText(instance));
}

export interface GgufOptions extends InstallOptions {
  /** The services the node's row in the node unit's node list reserves it for, or null. */
  role: string | null;
  /** The catalogue's verb, which records the node once the engine answers. */
  settings: Pick<GgufSettings, "catalogue">;
}

export type GgufOutcome = Omit<InstallOutcome, "step" | "done"> & {
  step: InstallOutcome["step"] | "reserved" | "placed";
  done: Array<InstallOutcome["done"][number] | "placed">;
};

/** The instance stood up or brought up to date on its node, and its node recorded in the catalogue entry
 * once the engine answers through the door. A node reserved for other services is refused before
 * anything reaches it. */
export async function installGguf(instance: GgufInstance, options: GgufOptions): Promise<GgufOutcome> {
  const { entry, serving } = instance;
  const refused = reservedAgainst(ENGINE, serving.node, { role: options.role });
  if (refused !== null) {
    return { ok: false, step: "reserved", fault: refused, done: [] };
  }
  const rendered = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `${serving.name}-units-`));
  let outcome: InstallOutcome;
  try {
    writeRendered(instance, rendered, options.checkout);
    const calls = options.calls ?? nodeCalls(options.runner, options.console, serving.node);
    outcome = await installTunnelledService(ggufService(instance, rendered), {
      ...options, calls,
    });
  } finally {
    rmSync(rendered, { recursive: true, force: true });
  }
  if (!outcome.ok) {
    return outcome;
  }
  const placed = await options.runner(placedCommand(options.settings, entry.name, serving.node));
  if (placed.code !== 0) {
    return { ok: false, step: "placed", fault: `${serving.node} could not be recorded in ${entry.name} — ${runFault(placed)}`, done: outcome.done };
  }

  return { ...outcome, done: [...outcome.done, "placed"] };
}

/** One file a dry run shows: where it would stand, at which mode, and what it would hold, with the key
 * never in it. */
export interface PlannedFile {
  side: "node" | "operations";
  path: string;
  mode: string;
  text: string;
}

export interface DryRunOptions {
  checkout?: string;
  tunnel?: TunnelEnds;
  keyPath?: string;
  hostKeyPath?: string;
}

/** What an install would write, on the node under the account's home and on the operations machine, and
 * nothing written. The key stands as the name of the file it is read from. */
export function plannedFiles(instance: GgufInstance, options: DryRunOptions = {}): PlannedFile[] {
  const { entry, serving } = instance;
  const config = configDir(serving);
  const tunnel = options.tunnel ?? tunnelEnds();
  const keyPath = options.keyPath ?? ggufKeyPath(serving);
  const key = `<the key in ${keyPath}>`;
  const hostKeyPath = options.hostKeyPath ?? "/etc/ssh/ssh_host_ed25519_key.pub";
  const pinned = existsSync(hostKeyPath) ? knownHostsLine(readFileSync(hostKeyPath, "utf8"), tunnel.host) : null;
  const units = renderUnits(instance, options.checkout);

  return [
    ...units.map(([name, text]): PlannedFile => ({ side: "node", path: `.config/systemd/user/${name}`, mode: "0664", text })),
    ...units.map(([name, text]): PlannedFile => ({ side: "node", path: `${serving.name}/${name}`, mode: "0664", text })),
    { side: "node", path: `${serving.name}/${SETUP_ENV}`, mode: "0664", text: setupEnvText(instance) },
    { side: "node", path: `${serving.name}/${NODE_SETUP}`, mode: "0775", text: readFileSync(join(templatesDir(options.checkout), NODE_SETUP), "utf8") },
    { side: "node", path: `${config}/env`, mode: "0600", text: envText(serving, key) + tunnelLines(tunnel) },
    ...configFiles(entry, key).map(([name, text]): PlannedFile => ({ side: "node", path: `${config}/${name}`, mode: "0600", text })),
    { side: "node", path: `${config}/known_hosts`, mode: "0600", text: pinned === null ? `<no host key could be read from ${hostKeyPath}>\n` : `${pinned}\n` },
    {
      side: "operations", path: join(homeDir(), ".ssh", "authorized_keys"), mode: "0600",
      text: `${authorizedLine(`<the public half of ~/${config}/tunnel_ed25519 on ${serving.node}>`, serving.listen)}\n`,
    },
    { side: "operations", path: doorListPath(), mode: "0600", text: `${keyPath}\n` },
  ];
}

/** The dry run's files written under a folder as they would stand: the node's under `node/`, the
 * operations machine's under `operations/` by their full path. */
export function writePlanned(files: readonly PlannedFile[], folder: string): void {
  for (const file of files) {
    const path = join(folder, file.side, file.path.replace(/^\//, ""));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
  }
}

export type UninstallStep = "reserved" | "node" | "authorized-keys" | "door" | "key";

export interface UninstallOutcome {
  ok: boolean;
  step: UninstallStep | null;
  fault: string | null;
}

export interface UninstallOptions {
  runner: NodeRunner;
  console: string;
  calls?: NodeCalls;
  keyPath?: string;
  doorListPath?: string;
  authorizedKeysPath?: string;
  say?: (line: string) => void;
}

/** The node's part taken away: the units stopped, disabled and removed, the settings folder with its keys,
 * and every file of the instance's folder but the models, which stay as every file once served does. */
export function nodeRemovalCommand(serving: Pick<Serving, "name">): string {
  const runtime = "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";
  const names = unitNames(serving);
  const units = [names.engine, names.tunnel];

  return `${runtime} && { systemctl --user disable --now ${units.join(" ")} 2>/dev/null; true; }`
    + ` && rm -f ${units.map((unit) => `~/.config/systemd/user/${unit}`).join(" ")} && systemctl --user daemon-reload`
    + ` && rm -rf ~/${configDir(serving)}`
    + ` && { test ! -d ~/${serving.name} || find ~/${serving.name} -mindepth 1 -maxdepth 1 ! -name models -exec rm -rf {} +; }`;
}

/** The instance taken down: its node's part, its tunnel's entry and its door key on the operations
 * machine, and its key. The catalogue is left as it stands, since the model's file stays on the node. */
export async function uninstallGguf(instance: GgufInstance, options: UninstallOptions): Promise<UninstallOutcome> {
  const { serving } = instance;
  const say = options.say ?? (() => {});
  const { exec } = options.calls ?? nodeCalls(options.runner, options.console, serving.node);
  const keyPath = options.keyPath ?? ggufKeyPath(serving);

  const read = await exec(`cat ~/${configDir(serving)}/tunnel_ed25519.pub 2>/dev/null || true`);
  const publicKey = read.stdout.split("\n").map((line) => line.trim()).find((line) => line.startsWith("ssh-")) ?? null;
  const removed = await exec(nodeRemovalCommand(serving));
  if (removed.code !== 0) {
    return { ok: false, step: "node", fault: `${serving.node}'s units and settings could not be taken away — ${runFault(removed)}` };
  }
  say(`${serving.node}: the units and the settings folder are gone; the models stay in ~/${serving.name}/models`);

  const entries = removeAuthorized(options.authorizedKeysPath ?? join(homeDir(), ".ssh", "authorized_keys"), publicKey, serving.listen);
  say(entries === 0 ? "no tunnel entry stood on the operations machine" : "the tunnel's entry on the operations machine is gone");
  const door = removeDoorKey(options.doorListPath ?? doorListPath(), keyPath);
  say(door === "removed" ? "the key is out of the door's list" : "the key stood in the door's list no longer");
  rmSync(keyPath, { force: true });
  say("the key is gone");

  return { ok: true, step: null, fault: null };
}
