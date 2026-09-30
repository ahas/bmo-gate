import { join } from "node:path";

import { healthUrl, installTunnelledService } from "./tunnel-install";
import { dataPath } from "./roots";

import type { InstallOptions, InstallOutcome, TunnelledService } from "./tunnel-install";

// The uncensored text model as the tunnelled install sees it (docs/n5-llm.md, 「Installing and
// updating」). It first stood on n5 alone; the same setup now stands on n2 to n5, one uncensored front
// a node, each reached through its own tunnel door on main-host. A node is one instance of the one
// service: its files, folders and units are the same on every node, since the nodes share no
// filesystem, and only its main-host port and its key file are its own. The service keeps the name
// n5-llm after where it began.

// The nodes the text model stands on. n5 is first, so a caller that names none still means it.
export const TEXT_NODES = ["n5", "n2", "n3", "n4"] as const;
export type TextNode = (typeof TEXT_NODES)[number];

// n5's port is unchanged; the others take ports of their own on main-host's loopback, clear of n6's
// (18010) and the bridge's own (18022).
const TEXT_LISTEN: Record<TextNode, string> = {
  n5: "127.0.0.1:18020",
  n2: "127.0.0.1:18021",
  n3: "127.0.0.1:18023",
  n4: "127.0.0.1:18024",
};

// The node-side names, one set for every node since the nodes share no filesystem.
export const N5_SERVICE_DIR = "n5-llm";
export const N5_CONFIG_DIR = ".config/n5-llm";

/** What goes across from `n5-llm/`. The tests stay here. */
export const N5_FILES: readonly string[] = [
  "front.py", "pyproject.toml", "node-setup.sh", "llama-nkvo.patch", "n5-llm-front.service", "n5-llm-tunnel.service",
];

export const N5_UNITS: readonly string[] = ["n5-llm-front.service", "n5-llm-tunnel.service"];

export function isTextNode(node: string): node is TextNode {
  return (TEXT_NODES as readonly string[]).includes(node);
}

function listenOf(node: string): string {
  if (!isTextNode(node)) {
    throw new Error(`${node} 는 텍스트 모델 노드가 아닙니다 (${TEXT_NODES.join(", ")}).`);
  }

  return TEXT_LISTEN[node];
}

/** The service's own key file on main-host, one a node, which is also its tunnel's key at the door. */
export function textKeyPath(node: string): string {
  return dataPath("env", `${node}-llm.token`);
}

/** The base URL an OpenAI client is given on main-host for a node's front. */
export function textBaseUrl(node: string): string {
  return `http://${listenOf(node)}/v1`;
}

/** One node's text model as the shared tunnelled install reads it (`src/tunnel-install.ts`). */
export function textModelService(node: string): TunnelledService {
  const listen = listenOf(node);

  return {
    node,
    serviceDir: N5_SERVICE_DIR,
    configDir: N5_CONFIG_DIR,
    keyPath: () => textKeyPath(node),
    // The tunnel unit reads LISTEN from here for its one remote forward, so the same unit file serves
    // every node and only this file carries the node's port.
    envFileText: (key) => `LLM_KEY=${key}\nLISTEN=${listen}\n`,
    makeDirsCommand: () => `mkdir -p ~/${N5_SERVICE_DIR}/models ~/${N5_SERVICE_DIR}/slots ~/${N5_CONFIG_DIR} && chmod 700 ~/${N5_CONFIG_DIR}`,
    carried: (checkout, home) => [
      ...N5_FILES.map((name): [string, string] => [join(checkout, "n5-llm", name), `${home}/${N5_SERVICE_DIR}/${name}`]),
      // The tunnel dials the door the way n6's does, with the same client.
      [join(checkout, "llm-server", "ws-dial.py"), `${home}/${N5_SERVICE_DIR}/ws-dial.py`],
    ],
    setupDone: "N5-LLM-SETUP-DONE",
    units: N5_UNITS,
    listen,
    engineUnit: "n5-llm-front",
    label: `${node} 텍스트 모델(앞단, llama.cpp, 모델 파일)`,
  };
}

export function textHealthUrl(node: string): string {
  return healthUrl(textModelService(node));
}

export function installTextModel(node: string, options: InstallOptions): Promise<InstallOutcome> {
  return installTunnelledService(textModelService(node), options);
}

// n5 named the way it always was, so importers that name it keep working.
export const N5_NODE = "n5";
export const N5_LISTEN = TEXT_LISTEN.n5;

export function n5KeyPath(): string {
  return textKeyPath("n5");
}

export const N5_LLM_SERVICE: TunnelledService = textModelService("n5");
export const N5_HEALTH_URL = healthUrl(N5_LLM_SERVICE);

export function installN5Llm(options: InstallOptions): Promise<InstallOutcome> {
  return installTextModel("n5", options);
}
