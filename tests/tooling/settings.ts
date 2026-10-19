import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./scratch";
import { SETTINGS_VARIABLE } from "../../training/tooling/src/settings";

// The tooling's settings a test runs under (docs/training.md, 「The tooling and its settings」): a file of the
// test's own, named by the variable the tooling reads, holding neutral names and numbers for the chat agent and
// the owner and whatever else the test hands it. The file is the test's alone and goes with its scratch folder.

export const testNames = { agent_name: "Robin", owner_name: "Sam", agent_id: 7_000_001, owner_id: 10_000_001 } as const;

export function useToolingSettings(values: Readonly<Record<string, string | number | readonly string[]>> = {}): string {
  const path = join(scratchDir("bmo-tooling-settings-"), "tooling.toml");
  const lines = Object.entries({ ...testNames, ...values }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

  writeFileSync(path, `${lines.join("\n")}\n`);
  process.env[SETTINGS_VARIABLE] = path;

  return path;
}
