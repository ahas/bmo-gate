import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { bmoIdFrom, judgedCounts, messagesIn, openArchive, ownerIdFrom, recordedQuestions, roomsIn, sentMessages } from "../src/archive";
import { releaseArchiveCopy, takeArchiveCopy } from "../src/archive-copy";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { pseudonyms } from "../src/pii";
import { realMetaFile, realRows, realSourceGates, unjudgedFile } from "../src/real-rows";
import { gateFolder, refuseInsideCheckout, runFolder } from "../src/roots";

import type { ArchiveReads, RealMeta, RealSettings, SentRow } from "../src/real-rows";

// The rows the rooms' own conversation gives each gate, built and written unjudged
// (docs/gate-data.md, 「The real conversation source」). It asks no model: what it writes is the
// state every gate would have been given and the questions it would have been asked, and the
// answers are a judging pass's.
//
// With no folder to write into it counts and writes nothing, which is how a build starts: the
// count says which gates the rooms can fill and which have to be written on a road instead.

const usage = `usage: bun scripts/laya-real.ts [<실행>] [--gate <게이트>]… [--limit <n>] [--db <경로>] [--owner <번호>] [--bmo <번호>] [--calibration <비율>] [--test <비율>] [--seed <씨앗>] [--json]

방들의 실제 대화에서 게이트별 입력을 세운다. 판정은 붙이지 않는다 — 그건 laya-judge.ts 의 몫이다.
<실행> 을 주면 그 실행 폴더의 게이트마다 unjudged.jsonl 을 쓰고, 주지 않으면 세기만 한다.
--gate 는 게이트를 고른다(여러 번). 없으면 실제 대화로 설 수 있는 게이트 전부.
--limit 은 게이트당 최대 행 수(기본 6000). --db 는 읽을 아카이브 파일, 없으면 비모 아카이브의 사본을 새로 떠서 읽는다.
--owner 와 --bmo 는 하스와 비모의 번호. 없으면 BMO_OWNER_ID 와 BMO_BOT_ID(또는 BMO_BOT_TOKEN)에서 읽는다.
--calibration 은 온도 보정 몫(기본 0.15), --test 는 수치를 재는 몫(기본 0.15).
--seed 는 가명을 고르는 씨앗(기본 laya-real). 같은 씨앗이면 같은 방이 같은 사람들로 읽힌다.
--json 은 게이트별 개수를 그대로 낸다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--gate": true, "--limit": true, "--db": true, "--owner": true, "--bmo": true,
  "--calibration": true, "--test": true, "--seed": true, "--json": false,
});

if (!reading.ok || reading.loose.length > 1) {
  console.error(`laya-real: ${reading.trouble ?? "실행 이름은 하나까지입니다."}`);
  console.error(usage);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");
const gates = wanted.length === 0 ? [...realSourceGates] : wanted;

for (const gate of gates) {
  if (synthesisFor(gate) === null) {
    console.error(`laya-real: ${gate} 은 게이트 이름이 아닙니다. 하나를 고르세요: ${gateSyntheses.map((one) => one.gate).join(", ")}`);
    process.exit(2);
  }
}

// A file named is read as it stands; otherwise a copy of BMO's archive is taken for this run and the
// live one is never opened (docs/gate-data.md, 「The archive copy」).
const named = lastOf(reading, "--db");
const copy = named === undefined ? takeArchiveCopy() : null;

if (copy !== null) {
  process.on("exit", () => releaseArchiveCopy(copy));
}

const db = openArchive(named ?? copy!.path);
const ownerId = Number(lastOf(reading, "--owner") ?? ownerIdFrom());
const bmoId = Number(lastOf(reading, "--bmo") ?? bmoIdFrom());
const seed = lastOf(reading, "--seed") ?? "laya-real";
const settings: RealSettings = {
  who: { ownerId, bmoId, names: pseudonyms(seed, { ownerId, bmoId }) },
  shares: {
    calibration: Number(lastOf(reading, "--calibration") ?? "0.15"),
    test: Number(lastOf(reading, "--test") ?? "0.15"),
  },
  limit: Number(lastOf(reading, "--limit") ?? "6000"),
};

// The archive is read once per room however many gates want it: the biggest room is a hundred
// thousand messages, and reading it ten times is ten times the work for the same lines.
const held = new Map<number, ReturnType<typeof messagesIn>>();
let sentRows: SentRow[] | null = null;

const reads: ArchiveReads = {
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
  recorded: (stage) => recordedQuestions(db, stage),
  sent: () => (sentRows ??= sentMessages(db, bmoId).map((one) => ({ original: one.original, visible: one.visible, folded: one.folded }))),
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

  console.log(`${root} 에 썼어요.`);
}

if (asked(reading, "--json")) {
  console.log(JSON.stringify({ counts, judged, floors: { train: 4_000, minority: 1_000, evaluation: 1_000 } }, null, 2));
  process.exit(0);
}

console.log("게이트           행     학습    보정    시험");

for (const one of counts) {
  console.log(`${one.gate.padEnd(18)}${String(one.rows).padStart(6)}${String(one.train).padStart(8)}${String(one.calibration).padStart(8)}${String(one.test).padStart(8)}`);
}

console.log("");
console.log("지난 판정 수(입력을 고르는 데만 씁니다):");

for (const one of judged) {
  console.log(`  ${one.stage.padEnd(20)}${String(one.judgements).padStart(6)}  (턴 ${one.turns})`);
}

if (runName === undefined) {
  console.log("");
  console.log("행을 쓰려면 실행 이름을 주세요: bun scripts/laya-real.ts <실행>");
}
