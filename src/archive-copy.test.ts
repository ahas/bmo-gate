import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { scratchDir } from "./scratch";

import { aboutFile, pruneCopies, readCopy, releaseArchiveCopy, takeArchiveCopy } from "./archive-copy";

// A live archive standing in for BMO's: one message and a schema stamp, in the write-ahead mode the
// bot keeps it in.
function liveArchive(where: string): string {
  const path = join(where, "live.db");

  if (existsSync(path)) {
    return path;
  }

  const db = new Database(path);

  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE messages (chat_id INTEGER, message_id INTEGER, text TEXT)");
  db.run("INSERT INTO messages VALUES (-7, 1, '안녕')");
  db.run("PRAGMA user_version = 7");
  db.close();

  return path;
}

const living = new Set([101, 102]);
const alive = (pid: number): boolean => living.has(pid);

function hands(where: string, pid: number, at: string) {
  return { root: join(where, "copies"), source: liveArchive(where), pid, now: () => new Date(at), alive };
}

describe("takeArchiveCopy", () => {
  test("copies the archive whole and says when, from where and at which schema version", () => {
    const where = scratchDir("bmo-archive-copy-");
    const copy = takeArchiveCopy(hands(where, 101, "2026-09-25T03:00:00.000Z"));
    const db = new Database(copy.path, { readonly: true });

    expect(db.query("SELECT text FROM messages").get()).toEqual({ text: "안녕" });
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
    expect([copy.schemaVersion, copy.takenAt, copy.source]).toEqual([7, "2026-09-25T03:00:00.000Z", join(where, "live.db")]);
    expect(readCopy(copy.folder)).toEqual(copy);
    expect(copy.bytes).toBeGreaterThan(0);
  });

  test("removes the copies nobody reads, and keeps the newest and any a living run still reads", () => {
    const where = scratchDir("bmo-archive-copy-");
    const read = takeArchiveCopy(hands(where, 101, "2026-09-25T01:00:00.000Z"));
    const dropped = takeArchiveCopy(hands(where, 103, "2026-09-25T02:00:00.000Z"));
    const newest = takeArchiveCopy(hands(where, 104, "2026-09-25T03:00:00.000Z"));

    expect([existsSync(read.folder), existsSync(dropped.folder), existsSync(newest.folder)]).toEqual([true, false, true]);

    releaseArchiveCopy(read, 101);
    pruneCopies({ root: join(where, "copies"), alive });

    expect(readdirSync(join(where, "copies"))).toEqual([newest.folder.split("/").at(-1)!]);
  });

  test("a copy cut off before it was whole goes once its run is gone", () => {
    const where = scratchDir("bmo-archive-copy-");
    const root = join(where, "copies");
    const cut = join(root, "20260925T000000Z.105");

    mkdirSync(cut, { recursive: true });
    writeFileSync(join(cut, "bmo.db.partial"), "");
    writeFileSync(join(cut, ".reader.105"), "");

    const copy = takeArchiveCopy(hands(where, 101, "2026-09-25T03:00:00.000Z"));

    expect(existsSync(cut)).toBe(false);
    expect(existsSync(join(copy.folder, aboutFile))).toBe(true);
  });
});
