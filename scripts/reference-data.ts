import { join } from "node:path";

import { bmoIdFrom, messagesIn, openArchive, ownerIdFrom, roomsIn } from "../src/archive";
import { releaseArchiveCopy, takeArchiveCopy } from "../src/archive-copy";
import { codexEffort, codexJudgeRoad, codexModel } from "../src/codex-road";
import { asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { claimGate, releaseGate } from "../src/gate-claim";
import { layaDecide, layaHealth, servedCheckpoints } from "../src/laya-service";
import { pseudonyms, scrubText } from "../src/pii";
import { layaAnswersOf } from "../src/reference/figures";
import { isReferenceGate } from "../src/reference/labels";
import { bmoCommit, bmoInputs } from "../src/reference/live-inputs";
import { leaveRequest, leaveRoom } from "../src/reference/rows";
import { judgedPerPass, referenceTick } from "../src/reference/tick";
import { archiveTurnReads, readTurns } from "../src/reference/turns";
import { plainShapeLine } from "../src/room-shape";
import { dataPath, refuseInsideCheckout } from "../src/roots";

import type { ArchivedMessage } from "../src/archive";

// One pass of the reference gates' data (docs/reference-data.md): the turns out of BMO's archive,
// the inputs BMO's own code builds for them today, the labels still wanting judged within the pass's
// bound, every row assembled afresh, Laya asked again, and the figures.

const usage = `usage: bun scripts/reference-data.ts <실행> [--judge <n>] [--at-once <n>] [--effort <수준>] [--checkout <경로>] [--import <turns.jsonl>] [--no-judge] [--no-laya]

참조 게이트 네 개의 학습 데이터를 한 회차 만든다(docs/reference-data.md). 비모가 답한 턴을 아카이브에서 읽고,
게이트마다 비모 코드가 지금 조립하는 입력을 받아, 라벨이 없는 후보를 최신 턴부터 판정하고, 행을 모두 새로
조립해 gates/ 에 통째로 바꿔 넣는다.
<실행> 은 런타임 데이터 뿌리의 reference-data/ 아래 이름이거나 절대 경로다.
--judge 는 한 회차에 판정할 턴 수(기본 ${judgedPerPass}), --at-once 는 동시에 판정할 묶음 수(기본 4).
--effort 는 codex 추론 수준(기본 ${codexEffort}). --checkout 은 입력을 조립할 비모 체크아웃(기본 ~/.local/share/bmo/deploy).
회차마다 비모 아카이브의 사본을 떠서 턴과 입력을 모두 그 사본에서 읽는다.
--import 는 처음 판정의 턴 파일로, 라벨이 하나도 없는 실행에 한 번 들여온다(기본 reference-use/use-1/turns.jsonl).
--no-judge 는 판정 없이 행과 수치만, --no-laya 는 Laya 재질의 없이 돈다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--judge": true, "--at-once": true, "--effort": true, "--checkout": true, "--import": true, "--no-judge": false, "--no-laya": false,
});

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`reference-data: ${reading.trouble ?? "실행 이름을 하나 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const name = reading.loose[0]!;
const root = name.startsWith("/") ? name : dataPath("reference-data", name);
const refusal = refuseInsideCheckout(root);

if (refusal !== null) {
  console.error(refusal);
  process.exit(2);
}

// One pass at a time over a run: two would judge the same turns twice and swap the gates in under
// each other. A pass already going is doing this one's work, so standing down is not a failure.
const standing = claimGate(join(root, "claim"));

if (standing !== null) {
  console.log(`다른 회차가 돌고 있어서 이번에는 쉬어요.\n${standing}`);
  process.exit(0);
}

process.on("exit", () => releaseGate(join(root, "claim")));

const checkout = lastOf(reading, "--checkout") ?? join(process.env.HOME ?? "", ".local", "share", "bmo", "deploy");
// The turns and BMO's inputs for them are read from one copy of the archive taken now, and the live
// archive is never opened (docs/gate-data.md, 「The archive copy」).
const copy = takeArchiveCopy();

process.on("exit", () => releaseArchiveCopy(copy));

const db = openArchive(copy.path);
const ownerId = ownerIdFrom();
const bmoId = bmoIdFrom();
const rooms = roomsIn(db).map((room) => room.chatId);
const roomCache = new Map<number, ArchivedMessage[]>();
const room = (chatId: number): ArchivedMessage[] => {
  const held = roomCache.get(chatId) ?? messagesIn(db, chatId);

  roomCache.set(chatId, held);

  return held;
};

// Every person who ever spoke, given their stand-in in the order of their number, so the same person
// is the same stand-in in every pass however the turns grow.
const people = new Map((db.query(`SELECT sender_id AS id, sender_name AS name FROM messages WHERE sender_id IS NOT NULL
    GROUP BY sender_id ORDER BY sender_id`).all() as { id: number; name: string }[]).map((one) => [one.id, one.name]));
const names = pseudonyms("laya-real", { ownerId, bmoId });

for (const [id, said] of people) {
  names.nameOf(id, said);
  names.idOf(id);
}

const who = { ownerId, names };
const built = readTurns(archiveTurnReads(db, () => rooms, room), bmoId);
const judge = asked(reading, "--no-judge") ? null : codexJudgeRoad({ model: codexModel, effort: lastOf(reading, "--effort") ?? codexEffort });
const health = asked(reading, "--no-laya") ? null : await layaHealth();

if (!asked(reading, "--no-laya") && health === null) {
  console.error("reference-data: Laya 서비스에 닿지 않아 이번 회차는 다시 묻지 않아요.");
}

const report = await referenceTick({
  root,
  built,
  inputs: bmoInputs(checkout, copy.path),
  road: judge,
  judged: Number(lastOf(reading, "--judge") ?? judgedPerPass),
  atOnce: Math.max(1, Number(lastOf(reading, "--at-once") ?? "4")),
  messages: (turn) => {
    const messages = room(turn.chatId);

    return turn.messageIds.flatMap((id) => messages.find((one) => one.messageId === id) ?? []).map((one) => plainShapeLine(one, who));
  },
  leaveText: (text) => leaveRoom(scrubText(text), names, people),
  leaveRequest: (request) => leaveRequest(request, names, people),
  laya: health === null ? null : {
    served: new Map([...servedCheckpoints(health)].filter(([gate]) => isReferenceGate(gate))),
    ask: async (gate, request) => layaAnswersOf(await layaDecide(gate, request)),
  },
  bmoCommit: bmoCommit(checkout),
  archive: { takenAt: copy.takenAt, schemaVersion: copy.schemaVersion },
  importFrom: lastOf(reading, "--import") ?? dataPath("reference-use", "use-1", "turns.jsonl"),
  say: (line) => console.log(line),
});

console.log(`${root}/report.json 에 썼어요 — 턴 ${report.turns} · 판정 ${report.judgedTurns}턴 ${report.calls}묶음 · 라벨 ${report.labels} · Laya 물음 ${report.layaAsked} 재사용 ${report.layaReused}`);

for (const gate of report.gates) {
  const figures = report.figures.find((one) => one.gate === gate.gate)!;
  const rows = gate.rows.train + gate.rows.calibration + gate.rows.test;

  console.log(`${gate.gate.padEnd(18)} 행 ${rows} (기다림 ${gate.waiting}) · 예 ${gate.yes} · 아니오 ${gate.no} · 다툼 ${gate.contested} · 예 든 행 ${gate.rowsWithYes} · 붙임 ${figures.attached} (씀 ${figures.used} · 관련 ${figures.related} · 안 씀 ${figures.unused}) · 누락 턴 ${figures.missTurns}`);
}

process.exit(report.failedBatches > 0 ? 1 : 0);
