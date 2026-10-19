import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataRoot } from "./roots";

// Which registered nodes a service stands on is state, not code: each service reads its own placement
// file from the data root at every run (docs/llm-server.md, 「The placement」, and docs/training.md,
// 「The nodes」). This module is only the reading; the service says
// which file is its own, the shape it is written in, and what in it is valid. A command that moves a
// service writes the file whole, through the same reading, so a file written here always reads back.

/** One service's placement file: its name, the shape a person writes it in, and its reading. */
export interface PlacementFile<T> {
  /** The file's name under the data root's `placements/`. */
  readonly file: string;
  /** The shape it is written in, shown whole when the file is missing or wrong. */
  readonly shape: string;
  /** The parsed JSON read as the service's own value; throws a `PlacementFault` saying what is wrong. */
  read(value: unknown): T;
}

/** What is wrong with a placement's content, said by the service's own reading. */
export class PlacementFault extends Error {}

/** A placement that is missing or cannot be read, naming the file and the shape it wants. */
export class PlacementRefused extends Error {}

export function placementPath(file: string, root: string = dataRoot()): string {
  return join(root, "placements", file);
}

/** The service's placement as it stands now; refused, never guessed, where the file is absent or wrong. */
export function readPlacement<T>(placement: PlacementFile<T>, root: string = dataRoot()): T {
  const path = placementPath(placement.file, root);
  const wanted = `write it as ${placement.shape}`;

  if (!existsSync(path)) {
    throw new PlacementRefused(`${path} is missing — ${wanted}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new PlacementRefused(`${path} is not JSON (${cause instanceof Error ? cause.message : String(cause)}) — ${wanted}`);
  }

  try {
    return placement.read(parsed);
  } catch (cause) {
    if (cause instanceof PlacementFault) {
      throw new PlacementRefused(`${path} could not be read: ${cause.message} — ${wanted}`);
    }
    throw cause;
  }
}

/** The placement written whole: read first through the service's own reading, which refuses a value it
 * would not read back, then written beside the file and renamed over it, so a reader at any moment
 * finds either the old placement or the new one, never half of either. */
export function writePlacement<T>(placement: PlacementFile<T>, value: unknown, root: string = dataRoot()): T {
  const read = placement.read(value);
  const path = placementPath(placement.file, root);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(partial, path);

  return read;
}

/** A command's reading of its placement: a refusal is said under the command's name and ends it. */
export function placementOrExit<T>(command: string, placement: PlacementFile<T>, root?: string): T {
  try {
    return readPlacement(placement, root);
  } catch (cause) {
    if (!(cause instanceof PlacementRefused)) {
      throw cause;
    }
    console.error(`${command}: ${cause.message}`);
    process.exit(2);
  }
}

// The small readings every service's own one is made of.

export function objectAt(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlacementFault(`${where} is not an object`);
  }

  return value as Record<string, unknown>;
}

export function listAt(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PlacementFault(`${where} is not a list`);
  }

  return value;
}

/** A registered node's name: what the node unit's node list calls it. */
export function nodeAt(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new PlacementFault(`${where} is not a registered node's name`);
  }

  return value;
}

export function textAt(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlacementFault(`${where} is empty or not a text`);
  }

  return value;
}

export function countAt(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new PlacementFault(`${where} is not a whole number above 0`);
  }

  return value;
}

export function flagAt(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") {
    throw new PlacementFault(`${where} is neither true nor false`);
  }

  return value;
}

/** Names that must not repeat within one placement. */
export function distinct(names: readonly string[], where: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new PlacementFault(`${where} holds ${name} twice`);
    }
    seen.add(name);
  }
}
