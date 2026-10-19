import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { scratchDir } from "./scratch";

import {
  aboutFile,
  openSnapshot,
  ownedReader,
  pruneSnapshots,
  readSnapshot,
  releaseSnapshot,
  takeSnapshot,
  unavailableLines,
  type PartReader,
} from "../../training/tooling/src/snapshot";
import { useToolingSettings } from "./settings";

useToolingSettings();

const living = new Set([101, 102]);
const alive = (pid: number): boolean => living.has(pid);

// The gate's own parts answered with one judgement, every other part unavailable.
const read: PartReader = (part) => part.owner !== "bmo-gate"
  ? { unavailable: `${part.owner} serves no route for its ${part.table}` }
  : { rows: part.table === "judgements" ? [{ id: 1, chat_id: -7, message_id: 3, stage: "room-rules", verdict: "NONE", llm: true }] : [] };

function hands(where: string, pid: number, at: string) {
  return { root: join(where, "snapshots"), pid, now: () => new Date(at), alive, read };
}

describe("takeSnapshot", () => {
  test("holds what each owner answered and says what could not be read", () => {
    const where = scratchDir("bmo-snapshot-");
    const snapshot = takeSnapshot(hands(where, 101, "2026-09-25T03:00:00.000Z"));
    const db = openSnapshot(snapshot.path);

    expect(db.query("SELECT chat_id AS chatId, message_id AS messageId, stage FROM judgements").all())
      .toEqual([{ chatId: -7, messageId: 3, stage: "room-rules" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    db.close();
    expect(snapshot.takenAt).toBe("2026-09-25T03:00:00.000Z");
    expect(snapshot.parts.find((part) => part.table === "judgements")).toEqual({ table: "judgements", owner: "bmo-gate", rows: 1 });
    expect(unavailableLines(snapshot)).toContain("messages: unavailable (bmo-receiver serves no route for its messages)");
    expect(readSnapshot(snapshot.folder)).toEqual(snapshot);
    expect(snapshot.bytes).toBeGreaterThan(0);
  });

  test("removes the snapshots nobody reads, and keeps the newest and any a living run still reads", () => {
    const where = scratchDir("bmo-snapshot-");
    const kept = takeSnapshot(hands(where, 101, "2026-09-25T01:00:00.000Z"));
    const dropped = takeSnapshot(hands(where, 103, "2026-09-25T02:00:00.000Z"));
    const newest = takeSnapshot(hands(where, 104, "2026-09-25T03:00:00.000Z"));

    expect([existsSync(kept.folder), existsSync(dropped.folder), existsSync(newest.folder)]).toEqual([true, false, true]);

    releaseSnapshot(kept, 101);
    pruneSnapshots({ root: join(where, "snapshots"), alive });

    expect(readdirSync(join(where, "snapshots"))).toEqual([newest.folder.split("/").at(-1)!]);
  });

  test("a snapshot cut off before it was whole goes once its run is gone", () => {
    const where = scratchDir("bmo-snapshot-");
    const cut = join(where, "snapshots", "20260925T000000Z.105");

    mkdirSync(cut, { recursive: true });
    writeFileSync(join(cut, "conversation.db.partial"), "");
    writeFileSync(join(cut, ".reader.105"), "");

    const snapshot = takeSnapshot(hands(where, 101, "2026-09-25T03:00:00.000Z"));

    expect(existsSync(cut)).toBe(false);
    expect(existsSync(join(snapshot.folder, aboutFile))).toBe(true);
  });
});

describe("ownedReader", () => {
  test("reads the gate's own records through its command and no other unit's part", () => {
    const where = scratchDir("bmo-snapshot-");
    const command = join(where, "records.sh");

    writeFileSync(command, `#!/bin/sh\n[ "$1" = records ] && echo '{"id":1,"stage":"'"$2"'"}'\n`, { mode: 0o755 });

    const reader = ownedReader(() => [command]);

    expect(reader({ table: "judgements", owner: "bmo-gate", columns: [] })).toEqual({ rows: [{ id: 1, stage: "judgements" }] });
    expect(reader({ table: "messages", owner: "bmo-receiver", columns: [] })).toEqual({ unavailable: "bmo-receiver serves no route for its messages" });
  });
});
