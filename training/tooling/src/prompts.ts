import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "./roots";
import { settingText } from "./settings";

// The words the tooling hands a model in the rooms' own language, which stand in the repository's
// `prompts/tooling/` folder rather than in the code (docs/layout.md, 「The rules the layout keeps」). Each
// file is TOML, read by Bun's own TOML reading the first time it is asked for and held after.
//
// A text may carry `{{name}}` marks, which `filled` fills: `{{agent}}` and `{{owner}}` with the names the
// tooling's settings give as `agent_name` and `owner_name`, read only where a text carries them, and every
// other mark with the value the caller hands it.

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

/** A table of texts in one of the files, named by its dotted path, each key's text in the order the file gives
 * them. A table standing inside it is a table of its own, asked for by its own path, and is no text of this one. */
export function promptTexts(name: string, table: string): Record<string, string> {
  const value = table.split(".").reduce<unknown>(
    (held, part) => typeof held === "object" && held !== null && !Array.isArray(held) ? (held as Record<string, unknown>)[part] : undefined,
    promptFile(name),
  );

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`prompts/tooling/${name}.toml holds no table ${table}`);
  }

  const texts: Record<string, string> = {};

  for (const [key, text] of Object.entries(value)) {
    if (typeof text === "object" && text !== null && !Array.isArray(text)) {
      continue;
    }

    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(`${table}.${key} in prompts/tooling/${name}.toml is not a text`);
    }

    texts[key] = text;
  }

  return texts;
}

/** One text of a table in one of the files. */
export function promptText(name: string, table: string, key: string): string {
  const text = promptTexts(name, table)[key];

  if (text === undefined) {
    throw new Error(`prompts/tooling/${name}.toml holds no ${table}.${key}`);
  }

  return text;
}

const marks = /\{\{([a-z_]+)\}\}/g;

/** The names the rooms' words are filled with: the chat agent's and the owner's, from the settings. */
export function roomName(mark: string): string | null {
  return mark === "agent" ? settingText("agent_name") : mark === "owner" ? settingText("owner_name") : null;
}

/** A text with every `{{name}}` mark filled; a mark neither the values nor the settings answer is refused. */
export function filled(text: string, values: Readonly<Record<string, string | number>> = {}): string {
  return text.replace(marks, (whole, mark: string) => {
    const given = values[mark];
    const value = given === undefined ? roomName(mark) : String(given);

    if (value === null) {
      throw new Error(`nothing fills ${whole} in: ${text}`);
    }

    return value;
  });
}
