import { dirname, join } from "node:path";

import { healthUrl, installTunnelledService } from "./tunnel-install";
import { dataPath } from "./roots";

import type { InstallOptions, InstallOutcome, TunnelledService } from "./tunnel-install";

// The Laya service on n6 as the tunnelled install sees it (docs/llm-server.md, 「Installing and
// updating」): its folders, what it carries from `llm-server/` and `laya-server/`, its units and where
// its tunnel listens on main-host.

/** The machine the service stands on. */
export const LLM_NODE = "n6";

/** The node's own folder for the front and the tunnel, and the one for their settings and secrets. */
export const SERVICE_DIR = "bmo-llm";
export const CONFIG_DIR = ".config/bmo-llm";

/** The engine's folder, the same one a training node keeps Laya in, and the gates' settings file,
 * which is made once and never overwritten. */
export const ENGINE_DIR = "bmo-laya";
export const GATES_SETTINGS = ".config/bmo-laya/env";

/** What goes across from `llm-server/`. The tests stay here. */
export const SERVICE_FILES: readonly string[] = [
  "front.py", "ws-dial.py", "pyproject.toml", "node-setup.sh", "bmo-llm-laya.service", "bmo-llm-front.service", "bmo-llm-tunnel.service",
];

/** What goes across from `laya-server/`: the engine and the setup that builds its venv. */
export const ENGINE_FILES: readonly string[] = ["server.py", "bench.py", "pyproject.toml", "node-setup.sh"];

export const UNITS: readonly string[] = ["bmo-llm-laya.service", "bmo-llm-front.service", "bmo-llm-tunnel.service"];

/** The one listen the tunnel is allowed on main-host, which is where BMO asks the service. */
export const TUNNEL_LISTEN = "127.0.0.1:18010";

/** The service's one key, which is the Laya token BMO asks with. */
export function serviceKeyPath(): string {
  return dataPath("env", "laya.token");
}

export const LAYA_SERVICE: TunnelledService = {
  node: LLM_NODE,
  serviceDir: SERVICE_DIR,
  configDir: CONFIG_DIR,
  keyPath: serviceKeyPath,
  // The key is in it twice, for the front and for the engine.
  envFileText: (key) => `LLM_KEY=${key}\nLAYA_TOKEN=${key}\n`,
  // The folders, and the gates' settings file naming no gate where none stands yet.
  makeDirsCommand: () =>
    `mkdir -p ~/${SERVICE_DIR} ~/${ENGINE_DIR} ~/${CONFIG_DIR} ~/${dirname(GATES_SETTINGS)} && chmod 700 ~/${CONFIG_DIR}`
    + ` && { test -f ~/${GATES_SETTINGS} || printf 'LAYA_CHECKPOINTS=""\\n' > ~/${GATES_SETTINGS}; }`,
  carried: (checkout, home) => [
    ...SERVICE_FILES.map((name): [string, string] => [join(checkout, "llm-server", name), `${home}/${SERVICE_DIR}/${name}`]),
    ...ENGINE_FILES.map((name): [string, string] => [join(checkout, "laya-server", name), `${home}/${ENGINE_DIR}/${name}`]),
  ],
  setupDone: "LLM-SETUP-DONE",
  units: UNITS,
  listen: TUNNEL_LISTEN,
  engineUnit: "bmo-llm-laya",
  label: "앞단과 Laya 엔진",
};

/** Where the service answers on main-host once the tunnel stands. */
export const HEALTH_URL = healthUrl(LAYA_SERVICE);

export function installLlmService(options: InstallOptions): Promise<InstallOutcome> {
  return installTunnelledService(LAYA_SERVICE, options);
}
