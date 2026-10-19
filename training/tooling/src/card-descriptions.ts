// What each service says of its own units on the cards (the arbiter's docs/placement.md, 「What a service
// says of its units」): a folder beside the placement rules holding one file per service, written by that service's
// own tooling and read by the card master, which shows each detail beside its unit. This is the writer's
// half: the folder, the shape and the write; what goes in a file is the service's alone.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The folder's name beside the placement rules. */
export const DESCRIPTIONS_FOLDER = "card-units";

/** What a unit of a layered model holds on its card: its main blocks (first and last, counted from 0),
 * whether the output layer and the MTP head are among them, and for a store how many full attention
 * blocks it keeps the KV of. */
export interface UnitDetail {
  blocks: { from: number; to: number } | null;
  output: boolean;
  mtp: boolean;
  fullAttention: number | null;
}

/** One service's file: each of its units by its full name, `<service>/<part>@<node>`. */
export interface UnitDescriptions {
  units: Record<string, UnitDetail>;
}

/** A service's file written whole, so the master never reads one half written. */
export function writeDescriptions(path: string, descriptions: UnitDescriptions): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  writeFileSync(partial, JSON.stringify(descriptions, null, 2) + "\n");
  renameSync(partial, path);
}
