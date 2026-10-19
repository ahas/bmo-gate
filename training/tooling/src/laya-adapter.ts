import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refused } from "./card-adapter";
import { homeCommand, parseHome, runFault } from "./node-calls";
import { carryCheckpoint, restartCommand } from "./laya-serve";
import { layaHealth, servedCheckpoints } from "./laya-service";
import { ENGINE_DIR, GATES_SETTINGS, installLlmService, LAYA_SERVICE_PLACEMENT, RELAY_LISTEN, SERVICE_NAME, UNITS } from "./llm-install";
import { connectionCalls, readConnection, reservedAgainst } from "./node-reach";
import { readPlacement, writePlacement } from "./placement";

import type { AdapterAnswer, AdapterAsk } from "./card-adapter";
import type { CarryAsk } from "./laya-serve";
import type { LlmInstallOptions, ServiceNode } from "./llm-install";
import type { NodeCalls, NodeRunner } from "./node-calls";
import type { InstallOutcome } from "./tunnel-install";

// The Laya service's adapter for the card master (docs/llm-server.md, 「Moving the service」): its
// placement kept in step with the master's placed nodes, the service installed on a node with every
// checkpoint another node serves carried there, and its units stopped where it is taken off. The arbiter,
// the node's role and its occupants are the master's.

/** A node reached: its calls and the service its row reserves it for. */
export interface Reached {
  calls: NodeCalls;
  role: string | null;
}

export interface LayaAdapterHands {
  runner: NodeRunner;
  console: string;
  /** The data root the placement stands under; the settings' by default. */
  root?: string;
  tmpRoot?: string;
  reach?: (node: string) => Promise<Reached | string>;
  install?: (at: ServiceNode, options: LlmInstallOptions) => Promise<InstallOutcome>;
  carry?: (ask: CarryAsk) => Promise<{ carried: boolean } | string>;
  /** A node's engine health with the key, at its own listen. */
  health?: (listen: string) => Promise<Record<string, unknown> | null>;
  wait?: (ms: number) => Promise<void>;
  polls?: number;
  everyMs?: number;
  say?: (line: string) => void;
}

const FIRST_LISTEN_PORT = Number(RELAY_LISTEN.split(":")[1]) + 1;

/** The lowest loopback listen on the operations machine no node of the placement takes, never the relay's own. */
export function freeListen(nodes: readonly ServiceNode[]): string {
  const taken = new Set(nodes.map((one) => one.listen));
  for (let port = FIRST_LISTEN_PORT; ; port += 1) {
    const listen = `127.0.0.1:${port}`;
    if (!taken.has(listen)) {
      return listen;
    }
  }
}

/** A placement entry as the file holds it: the bound on the card and the host copy only where given. */
function written(nodes: readonly ServiceNode[]): { nodes: Array<Record<string, unknown>> } {
  return {
    nodes: nodes.map(({ node, listen, cardModels, hostCopy }) => ({
      node,
      listen,
      ...(cardModels === null ? {} : { cardModels }),
      ...(hostCopy === null ? {} : { hostCopy }),
    })),
  };
}

/** The placement as the master's placed nodes, in their order: each node's entry as it stands, a node new
 * to it at the lowest free listen. */
export function placedEntries(standing: readonly ServiceNode[], placed: readonly string[]): ServiceNode[] {
  const entries: ServiceNode[] = [];
  for (const node of placed) {
    const entry = standing.find((one) => one.node === node) ?? { node, listen: freeListen([...standing, ...entries]), cardModels: null, hostCopy: null };
    entries.push(entry);
  }
  return entries;
}

/** The service's units on a node stopped and kept from starting with the machine; its files, its
 * checkpoints and its card arbiter stay. */
export function stopServiceCommand(): string {
  return `export XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; systemctl --user disable --now ${UNITS.join(" ")}`;
}

export function startServiceCommand(): string {
  return `export XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; systemctl --user enable --now ${UNITS.join(" ")}`;
}

async function defaultReach(node: string, hands: LayaAdapterHands): Promise<Reached | string> {
  const connection = await readConnection(node, hands.runner);
  return typeof connection === "string" ? connection : { calls: connectionCalls(connection, hands.runner, hands.console), role: connection.role };
}

function sameServed(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([gate, model]) => right.get(gate) === model);
}

/** One verb of the adapter, answered. */
export async function layaAdapter(ask: AdapterAsk, hands: LayaAdapterHands): Promise<AdapterAnswer> {
  const say = hands.say ?? (() => {});
  const reach = hands.reach ?? ((node: string) => defaultReach(node, hands));
  const health = hands.health ?? ((listen: string) => layaHealth(`http://${listen}`));
  const standing = readPlacement(LAYA_SERVICE_PLACEMENT, hands.root);
  const { node } = ask;

  if (ask.verb === "placed") {
    return { ok: true, node: null, state: null, detail: "", nodes: standing.map((one) => one.node) };
  }
  const entry = standing.find((one) => one.node === node);

  if (ask.verb === "health") {
    if (entry === undefined) {
      return { ok: true, node, state: "absent", detail: `${node} is not in the placement` };
    }
    const answered = await health(entry.listen);
    return answered === null
      ? { ok: true, node, state: "failing", detail: `the engine at ${entry.listen} does not answer` }
      : { ok: true, node, state: "running", detail: `${servedCheckpoints(answered).size} gates` };
  }

  const target = await reach(node!);
  if (typeof target === "string") {
    return refused(node, target);
  }

  if (ask.verb === "start" || ask.verb === "stop") {
    const ran = await target.calls.exec(ask.verb === "start" ? startServiceCommand() : stopServiceCommand());
    return ran.code === 0
      ? { ok: true, node, state: ask.verb === "start" ? "running" : "stopped", detail: "" }
      : refused(node, `the units could not be ${ask.verb === "start" ? "started" : "stopped"} — ${runFault(ran)}`);
  }

  if (ask.verb === "uninstall") {
    writePlacement(LAYA_SERVICE_PLACEMENT, written(placedEntries(standing, ask.placed)), hands.root);
    const stopped = await target.calls.exec(stopServiceCommand());
    if (stopped.code !== 0) {
      return refused(node, `the service's units could not be stopped — ${runFault(stopped)}`);
    }
    say(`${node}: the service's units are stopped and kept from starting with the machine (the installation and the checkpoints stay)`);
    return { ok: true, node, state: "stopped", detail: "" };
  }

  // install
  const reserved = reservedAgainst(SERVICE_NAME, node!, target);
  if (reserved !== null) {
    return refused(node, reserved);
  }

  // The gates as another placed node serves them now: its settings file as it stands, and what its engine
  // says it answers each gate with.
  let settings: string | null = null;
  let served = new Map<string, string>();
  for (const one of standing.filter((other) => other.node !== node && ask.placed.includes(other.node))) {
    const source = await reach(one.node);
    if (typeof source === "string") {
      say(`${one.node}: ${source}`);
      continue;
    }
    const read = await source.calls.exec(`cat ~/${GATES_SETTINGS}`);
    const answered = servedCheckpoints(await health(one.listen));
    if (read.code === 0 && answered.size > 0) {
      settings = read.stdout;
      served = answered;
      say(`moving the ${answered.size} gates of ${one.node}: ${[...answered.keys()].join(", ")}`);
      break;
    }
  }

  const entries = placedEntries(standing, ask.placed.includes(node!) ? ask.placed : [...ask.placed, node!]);
  writePlacement(LAYA_SERVICE_PLACEMENT, written(entries), hands.root);
  const at = entries.find((one) => one.node === node)!;
  say(`${node} stands at place ${entries.findIndex((one) => one.node === node) + 1} of the placement (${at.listen})`);

  const outcome = await (hands.install ?? installLlmService)(at, {
    runner: hands.runner, console: hands.console, calls: target.calls, role: target.role, tmpRoot: hands.tmpRoot, wait: hands.wait, say,
  });
  if (!outcome.ok) {
    return refused(node, `the install stopped at ${outcome.step} — ${outcome.fault}`);
  }
  if (settings === null) {
    return { ok: true, node, state: "running", detail: "installed alone, with no gate to move" };
  }

  for (const checkpoint of [...new Set(served.values())].map((model) => model.replace(/^checkpoints\//, ""))) {
    const carried = await (hands.carry ?? carryCheckpoint)({
      runner: hands.runner, console: hands.console, node: node!, calls: target.calls, checkpoint, dir: ENGINE_DIR, tmpRoot: hands.tmpRoot, say,
    });
    if (typeof carried === "string") {
      return refused(node, `${checkpoint}: ${carried}`);
    }
  }

  const home = parseHome((await target.calls.exec(homeCommand())).stdout);
  if (home === null) {
    return refused(node, `${node} does not answer`);
  }
  const scratch = mkdtempSync(join(hands.tmpRoot ?? tmpdir(), "bmo-laya-adapter-"));
  try {
    const local = join(scratch, "env");
    writeFileSync(local, settings);
    const sent = await target.calls.upload(local, `${home}/${GATES_SETTINGS}`);
    if (sent.code !== 0) {
      return refused(node, `the gates' settings could not be written — ${runFault(sent)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const restarted = await target.calls.exec(restartCommand());
  if (restarted.code !== 0) {
    return refused(node, `the engine could not be restarted — ${runFault(restarted)}`);
  }
  say(`${node}: waiting for the engine to take up ${served.size} gates`);
  const wait = hands.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  for (let poll = 0; poll < (hands.polls ?? 60); poll += 1) {
    await wait(hands.everyMs ?? 5_000);
    if (sameServed(servedCheckpoints(await health(at.listen)), served)) {
      return { ok: true, node, state: "running", detail: `it answers ${served.size} gates with the same checkpoints` };
    }
  }
  return refused(node, `the engine of ${node} does not answer the same gates with the same checkpoints — see journalctl --user -u bmo-llm-laya`);
}
