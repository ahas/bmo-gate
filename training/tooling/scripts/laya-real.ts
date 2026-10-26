import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { agentIdFrom, judgedCounts, messagesIn, ownerIdFrom, roomsIn, sentMessages } from "../src/conversation";
import { openSnapshot, readSnapshot, releaseSnapshot, snapshotFile, takeSnapshot, unavailableLines } from "../src/snapshot";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { pseudonyms } from "../src/pii";
import { realMetaFile, realRows, realSourceGates, unjudgedFile } from "../src/real-rows";
import { gateFolder, refuseInsideCheckout, runFolder } from "../src/roots";

import type { ConversationReads, RealMeta, RealSettings, SentRow } from "../src/real-rows";

// The rows the rooms' own conversation gives each gate, built and written unjudged
// (docs/gate-data.md, 「The real rows」). It asks no model: what it writes is the
// state every gate would have been given and the questions it would have been asked, and the
// answers are a judging pass's.
//
// With no folder to write into it counts and writes nothing, which is how a build starts: the
// count says which gates the rooms can fill and which have to be written on a road instead.

const usage = `usage: bun scripts/laya-real.ts [<run>] [--gate <gate>]… [--limit <n>] [--snapshot <folder>] [--owner <number>] [--agent <number>] [--calibration <share>] [--test <share>] [--seed <seed>] [--json]

Builds each gate's inputs out of the rooms' real conversation. No judgement is put on them; that is laya-judge.ts's.
Given <run>, writes an unjudged.jsonl for each gate of that run folder; without it, only counts.
--gate picks a gate (many times). Every gate the real conversation can stand where none is given.
--limit is the most rows a gate (default 6000). --snapshot names a conversation snapshot to read as it stands;
  without it, a snapshot is taken for this run.
--owner and --agent are the owner's and the chat agent's numbers; without them, the settings' owner_id and agent_id.
--calibration is the temperature calibration's share (default 0.15), --test the share the figures are read on (default 0.15).
--seed is the seed the stand-ins are chosen by (default laya-real). The same seed reads the same room as the same people.
--json prints the counts a gate as they stand.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--gate": true, "--limit": true, "--snapshot": true, "--owner": true, "--agent": true,
  "--calibration": true, "--test": true, "--seed": true, "--json": false,
});

if (!reading.ok || reading.loose.length > 1) {
  console.error(`laya-real: ${reading.trouble ?? "one run name at most."}`);
  console.error(usage);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");
const gates = wanted.length === 0 ? [...realSourceGates] : wanted;

for (const gate of gates) {
  if (synthesisFor(gate) === null) {
    console.error(`laya-real: ${gate}: no such gate. Choose among: ${gateSyntheses().map((one) => one.gate).join(", ")}`);
    process.exit(2);
  }
}

// A snapshot named is read as it stands; otherwise one is taken for this run (docs/gate-data.md, 「The
// conversation source」), and what it could not read is said.
const named = lastOf(reading, "--snapshot");
const taken = named === undefined ? takeSnapshot() : null;

if (taken !== null) {
  process.on("exit", () => releaseSnapshot(taken));
}

const snapshot = taken ?? readSnapshot(named!);

if (snapshot === null) {
  console.error(`laya-real: ${named} is not a whole snapshot.`);
  process.exit(2);
}

for (const line of unavailableLines(snapshot)) {
  console.error(`laya-real: ${line}`);
}

const db = openSnapshot(taken?.path ?? join(named!, snapshotFile));
const ownerId = Number(lastOf(reading, "--owner") ?? ownerIdFrom());
const agentId = Number(lastOf(reading, "--agent") ?? agentIdFrom());
const seed = lastOf(reading, "--seed") ?? "laya-real";
const settings: RealSettings = {
  who: { ownerId, agentId, names: pseudonyms(seed, { ownerId, agentId }) },
  shares: {
    calibration: Number(lastOf(reading, "--calibration") ?? "0.15"),
    test: Number(lastOf(reading, "--test") ?? "0.15"),
  },
  limit: Number(lastOf(reading, "--limit") ?? "6000"),
};

// The snapshot is read once per room however many gates want it: the biggest room is a hundred
// thousand messages, and reading it ten times is ten times the work for the same lines.
const held = new Map<number, ReturnType<typeof messagesIn>>();
let sentRows: SentRow[] | null = null;

const reads: ConversationReads = {
  rooms: () => roomsIn(db).map((one) => one.chatId),
  messages: (chatId) => {
    const kept = held.get(chatId);

    if (kept !== undefined) {
      return kept;
    }

    const room = messagesIn(db, chatId);

    held.set(chatId, room);

    return room;
  },
  sent: () => (sentRows ??= sentMessages(db, agentId).map((one) => ({ original: one.original, visible: one.visible, folded: one.folded }))),
};

const built = realRows(reads, settings, gates);
const counts = gates.map((gate) => {
  const rows = built.get(gate) ?? [];

  return {
    gate,
    rows: rows.length,
    train: rows.filter((row) => row.split === "train").length,
    calibration: rows.filter((row) => row.split === "calibration").length,
    test: rows.filter((row) => row.split === "test").length,
  };
});

// What the gates were really asked about, which is what says where the rooms are thin. It is the
// only use the past verdicts are put to: the gates' prompts and structure have moved, so what
// those verdicts answered is not what today's gates would answer.
const judged = judgedCounts(db);
const runName = reading.loose[0];

if (runName !== undefined) {
  const root = runFolder(runName);
  const refusal = refuseInsideCheckout(root);

  if (refusal !== null) {
    console.error(refusal);
    process.exit(2);
  }

  for (const gate of gates) {
    const folder = gateFolder(root, gate);

    mkdirSync(folder, { recursive: true });

    const rows = built.get(gate) ?? [];

    writeFileSync(join(folder, unjudgedFile), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  }

  const meta: RealMeta = { built: new Date().toISOString(), seed, limit: settings.limit, shares: settings.shares, gates };

  writeFileSync(join(root, realMetaFile), `${JSON.stringify(meta, null, 2)}\n`);

  console.log(`written to ${root}.`);
}

if (asked(reading, "--json")) {
  console.log(JSON.stringify({ counts, judged, floors: { train: 4_000, minority: 1_000, evaluation: 1_000 } }, null, 2));
  process.exit(0);
}

console.log(`${"gate".padEnd(18)}${"rows".padStart(6)}${"train".padStart(8)}${"cal".padStart(8)}${"test".padStart(8)}`);

for (const one of counts) {
  console.log(`${one.gate.padEnd(18)}${String(one.rows).padStart(6)}${String(one.train).padStart(8)}${String(one.calibration).padStart(8)}${String(one.test).padStart(8)}`);
}

console.log("");
console.log("Past judgements (used only to choose the inputs):");

for (const one of judged) {
  console.log(`  ${one.stage.padEnd(20)}${String(one.judgements).padStart(6)}  (${one.turns} turns)`);
}

if (runName === undefined) {
  console.log("");
  console.log("Give a run name to write the rows: bun scripts/laya-real.ts <run>");
}
