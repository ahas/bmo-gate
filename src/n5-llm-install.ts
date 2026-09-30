import { join } from "node:path";

import { healthUrl, installTunnelledService } from "./tunnel-install";
import { dataPath } from "./roots";

import type { InstallOptions, InstallOutcome, TunnelledService } from "./tunnel-install";

// The text model on n5 as the tunnelled install sees it (docs/n5-llm.md, 「Installing and updating」):
// its folders, what it carries from `n5-llm/` with the tunnel's dial client from `llm-server/`, its two
// units and where its tunnel listens on main-host.

export const N5_NODE = "n5";
export const N5_SERVICE_DIR = "n5-llm";
export const N5_CONFIG_DIR = ".config/n5-llm";

/** What goes across from `n5-llm/`. The tests stay here. */
export const N5_FILES: readonly string[] = ["front.py", "pyproject.toml", "node-setup.sh", "n5-llm-front.service", "n5-llm-tunnel.service"];

export const N5_UNITS: readonly string[] = ["n5-llm-front.service", "n5-llm-tunnel.service"];

export const N5_LISTEN = "127.0.0.1:18020";

/** The service's own key, which is also its tunnel's key at the door. */
export function n5KeyPath(): string {
  return dataPath("env", "n5-llm.token");
}

export const N5_LLM_SERVICE: TunnelledService = {
  node: N5_NODE,
  serviceDir: N5_SERVICE_DIR,
  configDir: N5_CONFIG_DIR,
  keyPath: n5KeyPath,
  envFileText: (key) => `LLM_KEY=${key}\n`,
  makeDirsCommand: () => `mkdir -p ~/${N5_SERVICE_DIR}/models ~/${N5_CONFIG_DIR} && chmod 700 ~/${N5_CONFIG_DIR}`,
  carried: (checkout, home) => [
    ...N5_FILES.map((name): [string, string] => [join(checkout, "n5-llm", name), `${home}/${N5_SERVICE_DIR}/${name}`]),
    // The tunnel dials the door the way n6's does, with the same client.
    [join(checkout, "llm-server", "ws-dial.py"), `${home}/${N5_SERVICE_DIR}/ws-dial.py`],
  ],
  setupDone: "N5-LLM-SETUP-DONE",
  units: N5_UNITS,
  listen: N5_LISTEN,
  engineUnit: "n5-llm-front",
  label: "n5 텍스트 모델(앞단, llama.cpp, 모델 파일)",
};

export const N5_HEALTH_URL = healthUrl(N5_LLM_SERVICE);

export function installN5Llm(options: InstallOptions): Promise<InstallOutcome> {
  return installTunnelledService(N5_LLM_SERVICE, options);
}
