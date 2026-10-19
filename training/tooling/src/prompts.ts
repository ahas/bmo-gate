import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "./roots";

// The words the tooling hands a model in the rooms' own language, which stand in the repository's
// `prompts/tooling/` folder rather than in the code (docs/layout.md, 「The rules the layout keeps」). Each
// file is TOML, read by Bun's own TOML reading the first time it is asked for and held after.

const read = new Map<string, Record<string, unknown>>();

/** One file of `prompts/tooling/`, by its name without `.toml`. */
export function promptFile(name: string): Record<string, unknown> {
  const held = read.get(name);

  if (held !== undefined) {
    return held;
  }

  const path = join(repositoryRoot(), "prompts", "tooling", `${name}.toml`);
  const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

  read.set(name, parsed);

  return parsed;
}

/** A table of texts in one of the files, each key's text in the order the file gives them. */
export function promptTexts(name: string, table: string): Record<string, string> {
  const value = promptFile(name)[table];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`prompts/tooling/${name}.toml holds no table ${table}`);
  }

  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(`${table}.${key} in prompts/tooling/${name}.toml is not a text`);
    }
  }

  return value as Record<string, string>;
}
