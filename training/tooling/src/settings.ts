import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The tooling's settings (docs/training.md, 「The tooling and its settings」): one TOML file, read by Bun's
// own TOML reading at every ask, so a command or a test that names another file reads that one. A key the
// file does not give is refused where it is needed, naming the key and the file, and never filled in with a
// value of the tooling's own.

/** The variable that names the settings file ahead of the tooling's own folder. */
export const SETTINGS_VARIABLE = "BMO_GATE_TOOLING_SETTINGS";

/** A settings file that cannot be read, or a key it does not give. */
export class SettingsRefused extends Error {}

/** The file the settings are read from now. */
export function settingsPath(): string {
  const named = process.env[SETTINGS_VARIABLE];

  return named === undefined || named === "" ? join(dirname(import.meta.dir), "tooling.toml") : named;
}

/** Every key the file gives; none where the file is missing. */
export function readSettings(path: string = settingsPath()): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    return Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    throw new SettingsRefused(`${path} is not TOML: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** A key that is one text, or null where the file does not give it. */
export function optionalText(key: string, path: string = settingsPath()): string | null {
  const value = readSettings(path)[key];

  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new SettingsRefused(`${key} in ${path} is not a text`);
  }

  return value;
}

/** A key that is one text the command needs. */
export function settingText(key: string, path: string = settingsPath()): string {
  const value = optionalText(key, path);

  if (value === null) {
    throw new SettingsRefused(`${path} gives no ${key}, which this command needs`);
  }

  return value;
}

/** A key that is one whole number the command needs, such as an account's number. */
export function settingNumber(key: string, path: string = settingsPath()): number {
  const value = readSettings(path)[key];

  if (value === undefined) {
    throw new SettingsRefused(`${path} gives no ${key}, which this command needs`);
  }
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new SettingsRefused(`${key} in ${path} is not a whole number`);
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number)) {
    throw new SettingsRefused(`${key} in ${path} is not a whole number`);
  }

  return number;
}

/** A key that is a list of words the command needs, such as a command line. */
export function settingWords(key: string, path: string = settingsPath()): string[] {
  const value = readSettings(path)[key];

  if (value === undefined) {
    throw new SettingsRefused(`${path} gives no ${key}, which this command needs`);
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((word) => typeof word === "string" && word !== "")) {
    throw new SettingsRefused(`${key} in ${path} is not a list of words`);
  }

  return value as string[];
}
