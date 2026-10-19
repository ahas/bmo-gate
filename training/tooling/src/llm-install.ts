import { dirname, join } from "node:path";

import { nodeCalls } from "./node-calls";
import { probeMachine } from "./machine";
import { reservedAgainst } from "./node-reach";
import { installTunnelledService } from "./tunnel-install";
import { countAt, listAt, nodeAt, objectAt, PlacementFault, textAt } from "./placement";
import { dataPath } from "./roots";
import { checkpointFolders } from "./weights";

import type { Machine } from "./machine";
import type { PlacementFile } from "./placement";
import type { InstallOptions, InstallOutcome, TunnelledService } from "./tunnel-install";

// The Laya service as the tunnelled install sees it (docs/llm-server.md, 「Installing and updating」):
// its folders, what it carries from `runtime/front/` and `runtime/laya-server/`, what it writes from the
// machine it lands on, its units, and where each node's tunnel listens on the operations machine. The card
// arbiter it stands on is put there first, by the arbiter's own install (the arbiter's docs/node-arbiter.md,
// 「Installing」).

/** The service's own name, the one a node's row may reserve the node for and its engine declares. */
export const SERVICE_NAME = "laya";

/** The relay's own listen on the operations machine, which is where the gate asks the service (docs/llm-server.md,
 * 「The relay」). */
export const RELAY_LISTEN = "127.0.0.1:18010";

/** The header every answer through the relay carries, naming the node that gave it. */
export const NODE_HEADER = "x-laya-node";

/** One node of the service, as its placement names it. */
export interface ServiceNode {
  node: string;
  /** Where its tunnel lands on the operations machine: a loopback address of its own. */
  listen: string;
  /** The most checkpoints the engine lets onto this node's card at once, below what the card itself
   * takes; null where the card alone decides. */
  cardModels: number | null;
  /** How the checkpoints wait in this node's host memory; null where the machine decides. */
  hostCopy: HostCopy | null;
}

/** The two ways the engine keeps a checkpoint in host memory (docs/laya-server.md, 「Host copies」). */
export type HostCopy = "pinned" | "mapped";

const HOST_COPIES: readonly HostCopy[] = ["pinned", "mapped"];

function hostCopyAt(value: unknown, where: string): HostCopy {
  const kind = HOST_COPIES.find((one) => one === value);
  if (kind === undefined) {
    throw new PlacementFault(`${where} is not ${HOST_COPIES.join(" or ")}`);
  }

  return kind;
}

const LOOPBACK_LISTEN = /^127\.0\.0\.1:(\d{1,5})$/;

function listenAt(value: unknown, where: string): string {
  const listen = textAt(value, where);
  const port = Number(LOOPBACK_LISTEN.exec(listen)?.[1] ?? "0");

  if (port < 1024 || port > 65535) {
    throw new PlacementFault(`${where} is not of the shape 127.0.0.1:<port>`);
  }
  if (listen === RELAY_LISTEN) {
    throw new PlacementFault(`${where} is the relay's own listen, ${RELAY_LISTEN}`);
  }

  return listen;
}

/** The nodes the service stands on, in the order they are asked (docs/llm-server.md, 「The placement」). */
export const LAYA_SERVICE_PLACEMENT: PlacementFile<ServiceNode[]> = {
  file: "laya-service.json",
  shape: '{"nodes": [{"node": "<node>", "listen": "127.0.0.1:<port>", "cardModels": <count, optional>, "hostCopy": "pinned|mapped, optional"}, …]}',
  read: (value) => {
    const listed = listAt(objectAt(value, "the file").nodes, "nodes");
    if (listed.length === 0) {
      throw new PlacementFault("nodes is empty");
    }
    const nodes = listed.map((one, index): ServiceNode => {
      const entry = objectAt(one, `nodes[${index}]`);

      return {
        node: nodeAt(entry.node, `nodes[${index}].node`),
        listen: listenAt(entry.listen, `nodes[${index}].listen`),
        cardModels: entry.cardModels === undefined ? null : countAt(entry.cardModels, `nodes[${index}].cardModels`),
        hostCopy: entry.hostCopy === undefined ? null : hostCopyAt(entry.hostCopy, `nodes[${index}].hostCopy`),
      };
    });
    for (const key of ["node", "listen"] as const) {
      const twice = nodes.find((one, index) => nodes.findIndex((other) => other[key] === one[key]) !== index);
      if (twice !== undefined) {
        throw new PlacementFault(`${key} ${twice[key]} stands twice`);
      }
    }

    return nodes;
  },
};

/** The node's own folder for the front and the tunnel, and the one for their settings and secrets. */
export const SERVICE_DIR = "bmo-llm";
export const CONFIG_DIR = ".config/bmo-llm";

/** The engine's folder, the same one a training node keeps Laya in, and the gates' settings file,
 * which is made once and never overwritten. */
export const ENGINE_DIR = "bmo-laya";
export const GATES_SETTINGS = ".config/bmo-laya/env";

/** Where the checkpoints stand on the node, outside the installation, as `weights/checkpoints.toml`
 * declares it: the engine's folder links to it, so a checkpoint's path under the engine's folder reads the
 * same whichever holds it. */
export const CHECKPOINT_STORE = checkpointFolders().nodeStore;
export const CHECKPOINT_LINK = `${ENGINE_DIR}/checkpoints`;

/** A watch of the card's, whose rules the card arbiter keeps, which must not run beside the engine: stopped
 * and removed wherever it stands. */
export const RETIRED_WATCH_UNIT = "bmo-llm-watch.service";

/** What goes across from `runtime/front/`. */
export const SERVICE_FILES: readonly string[] = [
  "front.py", "ws-dial.py", "pyproject.toml", "node-setup.sh",
  "bmo-llm-laya.service", "bmo-llm-front.service", "bmo-llm-tunnel.service",
];

/** What goes across from `runtime/laya-server/`: the engine, the card turn client it waits its turn for the
 * card through, and the setup that builds its venv. */
export const ENGINE_FILES: readonly string[] = ["server.py", "turn.py", "bench.py", "pyproject.toml", "node-setup.sh"];

export const UNITS: readonly string[] = ["bmo-llm-laya.service", "bmo-llm-front.service", "bmo-llm-tunnel.service"];

/** What a desktop keeps of its card beside the engine's batch, where the machine is a person's desktop. */
export const DESKTOP_KEEP_FREE_MIB = 2048;

/** The service's one key, which is the Laya token the gate asks with. */
export function serviceKeyPath(): string {
  return dataPath("env", "laya.token");
}

/** The engine's settings the machine decides: on a desktop, whose memory and card are a person's first,
 * the checkpoints wait mapped from files the kernel may drop rather than pinned, and the batch leaves
 * the desktop its share of the card. A host copy the placement entry names stands over the machine's. */
export function machineSettings(machine: Machine, hostCopy: HostCopy | null): string {
  const copy = hostCopy ?? (machine.wsl ? "mapped" : null);

  return (copy === null ? "" : `LAYA_HOST_COPY=${copy}\n`) + (machine.wsl ? `LAYA_CARD_KEEP_FREE_MIB=${DESKTOP_KEEP_FREE_MIB}\n` : "");
}

/** The store made, a checkpoint folder standing in the engine's own folder moved into it, and the link
 * put in its place; run again, it changes nothing. An empty store is replaced by the folder whole, a
 * rename; a store that already holds checkpoints takes every file it lacks and keeps its own, since a
 * checkpoint never changes under its name, and the folder goes once all of it stands in the store. */
export function checkpointStoreCommand(): string {
  const store = `~/${CHECKPOINT_STORE}`;
  const link = `~/${CHECKPOINT_LINK}`;

  return `mkdir -p ${store} && { if [ -d ${link} ] && [ ! -L ${link} ]; then `
    + `if rmdir ${store} 2>/dev/null; then mv ${link} ${store}; else cp -a -n ${link}/. ${store}/ && rm -rf ${link}; fi; fi; }`
    + ` && ln -sfn ${store} ${link}`;
}

/** The service as it stands on one of its nodes, on the machine the install read there. */
export function layaService(at: ServiceNode, machine: Machine): TunnelledService {
  return {
    node: at.node,
    serviceDir: SERVICE_DIR,
    configDir: CONFIG_DIR,
    keyPath: serviceKeyPath,
    // The key is in it twice, for the front and for the engine, the tunnel reads its listen there, the
    // engine its bound on the card where the placement gives one, and what the machine decides.
    envFileText: (key) => `LLM_KEY=${key}\nLAYA_TOKEN=${key}\nTUNNEL_LISTEN=${at.listen}\n`
      + (at.cardModels === null ? "" : `LAYA_CARD_MODELS=${at.cardModels}\n`) + machineSettings(machine, at.hostCopy),
    // The folders, the gates' settings file naming no gate where none stands yet, and the store.
    makeDirsCommand: () =>
      `mkdir -p ~/${SERVICE_DIR} ~/${ENGINE_DIR} ~/${CONFIG_DIR} ~/${dirname(GATES_SETTINGS)} && chmod 700 ~/${CONFIG_DIR}`
      + ` && { test -f ~/${GATES_SETTINGS} || printf 'LAYA_CHECKPOINTS=""\\n' > ~/${GATES_SETTINGS}; }`
      + ` && ${checkpointStoreCommand()}`,
    carried: (checkout, home) => [
      ...SERVICE_FILES.map((name): [string, string] => [join(checkout, "runtime", "front", name), `${home}/${SERVICE_DIR}/${name}`]),
      ...ENGINE_FILES.map((name): [string, string] => [join(checkout, "runtime", "laya-server", name), `${home}/${ENGINE_DIR}/${name}`]),
    ],
    setupDone: "LLM-SETUP-DONE",
    units: UNITS,
    unitsAbsent: [RETIRED_WATCH_UNIT],
    listen: at.listen,
    engineUnit: "bmo-llm-laya",
    label: "the front and the Laya engine",
  };
}

/** Where the service answers on the operations machine, whichever node takes the call. */
export const HEALTH_URL = `http://${RELAY_LISTEN}/health`;

export interface LlmInstallOptions extends InstallOptions {
  /** The services the node's row in the node unit's node list reserves it for, or null. */
  role: string | null;
}

/** The service on one node, written for the machine it reads there. A node reserved for another service is
 * refused before anything is put on it. The card arbiter it waits its turn through is the card master's
 * to stand (the arbiter's docs/placement.md, 「Placing the services」). */
export async function installLlmService(at: ServiceNode, options: LlmInstallOptions): Promise<InstallOutcome> {
  const refused = reservedAgainst(SERVICE_NAME, at.node, { role: options.role });
  if (refused !== null) {
    return { ok: false, step: "machine", fault: refused, done: [] };
  }
  const calls = options.calls ?? nodeCalls(options.runner, options.console, at.node);
  const machine = await probeMachine(calls.exec);
  if (typeof machine === "string") {
    return { ok: false, step: "machine", fault: machine, done: [] };
  }
  if (machine.card === null) {
    return { ok: false, step: "machine", fault: `no card is seen on ${at.node}`, done: [] };
  }
  options.say?.(`${at.node}: ${machine.card.name} ${machine.card.totalMiB} MiB${machine.wsl ? ", a WSL desktop" : ""}`);
  const outcome = await installTunnelledService(layaService(at, machine), { ...options, calls });

  return { ...outcome, done: ["machine", ...outcome.done] };
}
