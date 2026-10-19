import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writerAlive } from "./gate-claim";
import { dataPath } from "./roots";
import { settingWords } from "./settings";

// The snapshot of the rooms' conversation a run reads (docs/gate-data.md, 「The conversation source」). One
// folder a snapshot, named by when it was taken and by whom, holding one SQLite file, what the snapshot is, and
// a mark for every living run that reads it.
//
// Each part of the conversation is read from the unit that owns it and from nowhere else. The gate's own
// records are read through its own command; a part whose owner serves no route for it yet is made empty and
// said to be unavailable, so a run builds nothing that rests on it and says what it could not read.

export const snapshotFile = "conversation.db";
export const aboutFile = "snapshot.json";
const readerPrefix = ".reader.";

/** One part of the conversation as the snapshot holds it: the table, its columns, and the unit that owns it. */
export interface SnapshotPart {
  table: string;
  columns: readonly string[];
  owner: string;
}

// The parts the tooling's readers read (`conversation.ts`, `reference/turns.ts`), in the columns they read.
export const snapshotParts: readonly SnapshotPart[] = [
  {
    table: "messages",
    owner: "bmo-receiver",
    columns: ["chat_id", "message_id", "sender_id", "sender_name", "sent_at", "text", "image_path", "reply_to_message_id"],
  },
  { table: "telegram_messages", owner: "bmo-receiver", columns: ["chat_id", "message_id", "metadata"] },
  // The chat agent's own runs alone, so nothing reading it names the agent.
  { table: "agent_log", owner: "bmo-agency", columns: ["id", "run", "kind", "name", "text", "at"] },
  {
    table: "todos",
    owner: "bmo-job",
    columns: ["id", "chat_id", "title", "instruction", "requester", "requester_id", "report", "done", "done_at", "created_at", "merged_into"],
  },
  { table: "jobs", owner: "bmo-job", columns: ["id", "chat_id", "todo_id", "prompt", "launched_at"] },
  {
    table: "searches",
    owner: "bmo-artifact",
    columns: ["id", "chat_id", "kind", "status", "query", "document", "started_at", "finished_at"],
  },
  { table: "judgements", owner: "bmo-gate", columns: ["id", "chat_id", "message_id", "stage"] },
  { table: "laya_verdicts", owner: "bmo-gate", columns: ["id", "stage", "chat_id", "input"] },
  {
    table: "reference_verdicts",
    owner: "bmo-gate",
    columns: ["id", "stage", "chat_id", "message_id", "slug", "llm", "attached"],
  },
];

/** What one part came to: its rows, or why it could not be read. */
export type PartRead = { table: string; owner: string; rows: number } | { table: string; owner: string; unavailable: string };

export interface Snapshot {
  folder: string;
  path: string;
  takenAt: string;
  bytes: number;
  parts: PartRead[];
}

/** Every row of one part as its owner answers it, one JSON object a row, or why the owner serves none. */
export type PartReader = (part: SnapshotPart) => { rows: Record<string, unknown>[] } | { unavailable: string };

export interface SnapshotHands {
  root: string;
  pid: number;
  now: () => Date;
  alive: (pid: number) => boolean;
  read: PartReader;
}

export function snapshotsRoot(): string {
  return dataPath("conversation-snapshots");
}

// The gate's own records through its command, `bmo-gate records <table>` (the gate's docs/boundary-api.md,
// 「Records」), run as the settings' `gate_command` names it. No other unit serves a route for its part yet.
export function ownedReader(command: () => string[] = () => settingWords("gate_command")): PartReader {
  return (part) => {
    if (part.owner !== "bmo-gate") {
      return { unavailable: `${part.owner} serves no route for its ${part.table}` };
    }

    const done = Bun.spawnSync([...command(), "records", part.table], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

    if (done.exitCode !== 0) {
      throw new Error(`reading the gate's ${part.table} failed: ${done.stderr.toString().trim() || done.stdout.toString().trim()}`);
    }

    return {
      rows: done.stdout.toString().split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  };
}

// The hands a take is given, its own standing for any it is not; the data root is asked for only where no root
// is given.
function ownHands(given: Partial<SnapshotHands>): SnapshotHands {
  return {
    root: given.root ?? snapshotsRoot(),
    pid: given.pid ?? process.pid,
    now: given.now ?? (() => new Date()),
    alive: given.alive ?? writerAlive,
    read: given.read ?? ownedReader(),
  };
}

// A name that sorts in the order the snapshots were taken.
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

export function readSnapshot(folder: string): Snapshot | null {
  try {
    return { folder, ...JSON.parse(readFileSync(join(folder, aboutFile), "utf8")) as Omit<Snapshot, "folder"> };
  } catch {
    return null;
  }
}

// Every snapshot but the newest whole one, where no living run reads it. A folder with no account of itself is
// a snapshot cut off before it was whole, and goes the same way.
export function pruneSnapshots(hands: Partial<SnapshotHands> = {}): string[] {
  const { root, alive } = { root: hands.root ?? snapshotsRoot(), alive: hands.alive ?? writerAlive };

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

// A part's table, filled with what its owner answered, each row's columns taken by name.
function writePart(db: Database, part: SnapshotPart, rows: readonly Record<string, unknown>[]): void {
  db.run(`CREATE TABLE ${part.table} (${part.columns.join(", ")})`);

  const insert = db.prepare(`INSERT INTO ${part.table} (${part.columns.join(", ")}) VALUES (${part.columns.map(() => "?").join(", ")})`);
  const value = (held: unknown): string | number | bigint | null =>
    held === undefined || held === null ? null
      : typeof held === "boolean" ? Number(held)
        : typeof held === "number" || typeof held === "bigint" || typeof held === "string" ? held
          : JSON.stringify(held);

  db.transaction(() => {
    for (const row of rows) {
      insert.run(...part.columns.map((column) => value(row[column])));
    }
  })();
}

// A snapshot of the conversation as its owners answer it now, marked as this run's for as long as it lives,
// with the snapshots nobody reads any more removed after it.
export function takeSnapshot(hands: Partial<SnapshotHands> = {}): Snapshot {
  const { root, pid, now, alive, read } = ownHands(hands);
  const at = now();
  const folder = join(root, folderName(at, pid));
  const path = join(folder, snapshotFile);
  const partial = `${path}.partial`;

  // The mark first, so a prune running beside the take never removes the folder under it.
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${readerPrefix}${pid}`), "");

  const db = new Database(partial);
  const parts: PartRead[] = [];

  try {
    for (const part of snapshotParts) {
      const answered = read(part);

      writePart(db, part, "rows" in answered ? answered.rows : []);
      parts.push("rows" in answered
        ? { table: part.table, owner: part.owner, rows: answered.rows.length }
        : { table: part.table, owner: part.owner, unavailable: answered.unavailable });
    }
  } finally {
    db.close();
  }

  renameSync(partial, path);

  const about = { path, takenAt: at.toISOString(), bytes: statSync(path).size, parts };

  writeFileSync(join(folder, aboutFile), `${JSON.stringify(about, null, 2)}\n`);
  pruneSnapshots({ root, alive });

  return { folder, ...about };
}

/** The run is done with its snapshot. It stays until a later take finds it old and unread. */
export function releaseSnapshot(snapshot: Snapshot, pid: number = process.pid): void {
  rmSync(join(snapshot.folder, `${readerPrefix}${pid}`), { force: true });
}

/** A snapshot's file, opened to be read and never written. */
export function openSnapshot(path: string): Database {
  return new Database(path, { readonly: true });
}

/** The lines a run says of the parts it could not read. */
export function unavailableLines(snapshot: Pick<Snapshot, "parts">): string[] {
  return snapshot.parts.flatMap((part) => "unavailable" in part ? [`${part.table}: unavailable (${part.unavailable})`] : []);
}
