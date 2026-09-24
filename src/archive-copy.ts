import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { liveArchivePath } from "./archive";
import { writerAlive } from "./gate-claim";
import { dataPath } from "./roots";

// The copy of BMO's archive a run reads instead of the live one (docs/gate-data.md, 「The archive
// copy」). One folder a copy, named by when it was taken and by whom, holding the file, what the
// copy is, and a mark for every living run that reads it.

export const copyFile = "bmo.db";
export const aboutFile = "copy.json";
const readerPrefix = ".reader.";

export interface ArchiveCopy {
  folder: string;
  path: string;
  source: string;
  takenAt: string;
  bytes: number;
  // The archive's own stamp, `PRAGMA user_version`, which BMO's code checks before it reads a file.
  schemaVersion: number;
}

export interface CopyHands {
  root: string;
  source: string;
  pid: number;
  now: () => Date;
  alive: (pid: number) => boolean;
}

export function copiesRoot(): string {
  return dataPath("archive-copies");
}

function ownHands(): CopyHands {
  return { root: copiesRoot(), source: liveArchivePath(), pid: process.pid, now: () => new Date(), alive: writerAlive };
}

// A name that sorts in the order the copies were taken.
function folderName(at: Date, pid: number): string {
  return `${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.${pid}`;
}

function readersOf(folder: string): number[] {
  try {
    return readdirSync(folder).flatMap((name) => name.startsWith(readerPrefix) ? [Number(name.slice(readerPrefix.length))] : [])
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

export function readCopy(folder: string): ArchiveCopy | null {
  try {
    return { folder, ...JSON.parse(readFileSync(join(folder, aboutFile), "utf8")) as Omit<ArchiveCopy, "folder"> };
  } catch {
    return null;
  }
}

// Every copy but the newest whole one, where no living run reads it. A folder with no account of
// itself is a copy cut off before it was whole, and goes the same way.
export function pruneCopies(hands: Partial<CopyHands> = {}): string[] {
  const { root, alive } = { ...ownHands(), ...hands };

  if (!existsSync(root)) {
    return [];
  }

  const folders = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory()).sort();
  const newest = folders.filter((name) => existsSync(join(root, name, aboutFile))).at(-1);
  const removed: string[] = [];

  for (const name of folders) {
    const folder = join(root, name);

    if (name === newest || readersOf(folder).some(alive)) {
      continue;
    }

    rmSync(folder, { recursive: true, force: true });
    removed.push(folder);
  }

  return removed;
}

// A copy of the archive as it stands, taken in one consistent read, marked as this run's for as
// long as it lives, with the copies nobody reads any more removed after it.
export function takeArchiveCopy(hands: Partial<CopyHands> = {}): ArchiveCopy {
  const { root, source, pid, now, alive } = { ...ownHands(), ...hands };
  const at = now();
  const folder = join(root, folderName(at, pid));
  const path = join(folder, copyFile);
  const partial = `${path}.partial`;

  // The mark first, so a prune running beside the take never removes the folder under it.
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${readerPrefix}${pid}`), "");

  const live = new Database(source, { readonly: true });

  try {
    live.run(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
  } finally {
    live.close();
  }

  // Put in write-ahead mode once here, so BMO's own opener, which asks for that mode, writes nothing.
  const copy = new Database(partial);
  let schemaVersion: number;

  try {
    copy.run("PRAGMA journal_mode = WAL");
    schemaVersion = (copy.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    copy.close();
  }

  renameSync(partial, path);

  const about = { path, source, takenAt: at.toISOString(), bytes: statSync(path).size, schemaVersion };

  writeFileSync(join(folder, aboutFile), `${JSON.stringify(about, null, 2)}\n`);
  pruneCopies({ root, alive });

  return { folder, ...about };
}

// The run is done with its copy. The copy stays until a later take finds it old and unread.
export function releaseArchiveCopy(copy: ArchiveCopy, pid: number = process.pid): void {
  rmSync(join(copy.folder, `${readerPrefix}${pid}`), { force: true });
}
