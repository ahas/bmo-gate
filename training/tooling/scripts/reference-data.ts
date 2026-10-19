import { join } from "node:path";

import { agentIdFrom, messagesIn, ownerIdFrom, roomsIn } from "../src/conversation";
import { openSnapshot, readSnapshot, releaseSnapshot, snapshotFile, takeSnapshot, unavailableLines } from "../src/snapshot";
import { accountIn, claudeAccount, claudeEffort, claudeJudgeRoad, claudeModel } from "../src/claude-road";
import { codexEffort, codexJudgeRoad, codexModel } from "../src/codex-road";
import { allOf, asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { claimGate, releaseGate } from "../src/gate-claim";
import { layaDecide, layaHealth, servedCheckpoints } from "../src/laya-service";
import { pseudonyms, scrubText } from "../src/pii";
import { layaAnswersOf } from "../src/reference/figures";
import { heldTo, judgedAgain, unlabelled } from "../src/reference/judge";
import { isReferenceGate, isWordFor } from "../src/reference/labels";
import { gateInputs, gateVersion } from "../src/reference/live-inputs";
import { leaveRequest, leaveRoom } from "../src/reference/rows";
import { judgedPerPass, referenceTick } from "../src/reference/tick";
import { isTurnSource, readTurns, snapshotTurnReads, turnSources } from "../src/reference/turns";
import { plainShapeLine } from "../src/room-shape";
import { dataPath, refuseInsideCheckout } from "../src/roots";

import type { ArchivedMessage } from "../src/conversation";
import type { UseWord } from "../src/reference/labels";

// One pass of the reference gates' data (docs/reference-data.md): the turns out of a conversation
// snapshot, the inputs the gate's own code builds for them today, the labels still wanting judged within
// the pass's bound, every row assembled afresh, Laya asked again, and the figures.

const usage = `usage: bun scripts/reference-data.ts <run> [--judge <n>] [--at-once <n>] [--road codex|claude] [--effort <level>] [--rejudge <word> --before <time>] [--gate <gate>]… [--source <source>]… [--snapshot <folder>] [--claude-login <directory>] [--import <turns.jsonl>] [--no-judge] [--no-laya]

Makes one pass of the four reference gates' training data (docs/reference-data.md). Reads the turns the chat agent
answered out of a conversation snapshot, takes for each gate the input the gate's own code assembles today, judges
the candidates with no label from the newest turn on, assembles every row afresh and swaps them into gates/ whole.
<run> is a name under the runtime data root's reference-data/ or an absolute path.
--judge is the turns judged a pass (default ${judgedPerPass}); --at-once the batches judged at once (default 4).
--road is the road that judges (default codex). claude is ${claudeModel} at ${claudeEffort}, pinned to the Claude login the settings name.
--claude-login <directory> pins the claude road to the account whose login stands in that directory instead, on the owner's word.
--effort is codex's reasoning level (default ${codexEffort}).
--rejudge judges again, in today's words, the labels judged with that word before <time>, in place of the candidates with no label.
--gate holds this pass's judging to those gates (many times).
--source holds this pass's judging to the turns of that source (${turnSources.join(", ")}) (many times).
  instructions is the turns the chat agent's own instructions opened, with no one's words.
  work is the jobs and searches the chat agent handed out, judged for the knowledge gate alone.
Each pass takes a conversation snapshot and reads its turns from it; --snapshot reads a kept one as it stands. The
inputs are built by the gate's command the settings name as gate_command.
--import is the first judging's turn file, taken in once into a run holding no label (default reference-use/use-1/turns.jsonl).
--no-judge runs with no judging, the rows and figures alone; --no-laya runs without asking Laya again.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--judge": true, "--at-once": true, "--road": true, "--effort": true, "--rejudge": true, "--before": true, "--gate": true, "--source": true,
  "--snapshot": true, "--import": true, "--claude-login": true, "--no-judge": false, "--no-laya": false,
});

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`reference-data: ${reading.trouble ?? "give one run name."}`);
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

// The road the judge rides, what that judge is as every frozen batch records it, and which pieces this
// pass asks it about. The claude road rides its own login unless the pass names another account's
// directory, which it is then pinned to alone (docs/gate-data.md, 「The claude road」).
const claudeLogin = lastOf(reading, "--claude-login");
const loginAccount = claudeLogin === undefined ? claudeAccount() : accountIn(claudeLogin);

if (loginAccount === null) {
  console.error(`reference-data: no Claude login stands in ${claudeLogin}.`);
  process.exit(2);
}

const roads = {
  codex: () => {
    const effort = lastOf(reading, "--effort") ?? codexEffort;

    return { road: codexJudgeRoad({ model: codexModel, effort }), judge: `codex ${codexModel} ${effort}` };
  },
  claude: () => ({
    road: claudeJudgeRoad(claudeLogin === undefined ? {} : { configDir: claudeLogin, account: loginAccount }),
    judge: `claude ${claudeModel} ${claudeEffort} ${loginAccount}`,
  }),
};
const roadName = lastOf(reading, "--road") ?? "codex";

if (!Object.hasOwn(roads, roadName)) {
  console.error(`reference-data: --road is one of ${Object.keys(roads).join(", ")}.`);
  process.exit(2);
}

const gates = allOf(reading, "--gate");
const strangeGate = gates.find((gate) => !isReferenceGate(gate));

if (strangeGate !== undefined) {
  console.error(`reference-data: ${strangeGate} is not a reference gate.`);
  process.exit(2);
}

const sources = allOf(reading, "--source");
const strangeSource = sources.find((source) => !isTurnSource(source));

if (strangeSource !== undefined) {
  console.error(`reference-data: ${strangeSource} is not a turn source; it is one of ${turnSources.join(", ")}.`);
  process.exit(2);
}

const again = lastOf(reading, "--rejudge");
const before = lastOf(reading, "--before");

if ((again === undefined) !== (before === undefined)) {
  console.error("reference-data: --rejudge and --before are given together.");
  process.exit(2);
}

if (again !== undefined && !isWordFor(true, again) && !isWordFor(false, again)) {
  console.error(`reference-data: ${again} is not a judging word.`);
  process.exit(2);
}

if (before !== undefined && Number.isNaN(Date.parse(before))) {
  console.error(`reference-data: --before ${before} does not read as a time.`);
  process.exit(2);
}

const wanting = heldTo(
  gates.filter(isReferenceGate),
  again === undefined || before === undefined ? unlabelled : judgedAgain(again as UseWord, new Date(before).toISOString()),
);

// One pass at a time over a run: two would judge the same turns twice and swap the gates in under
// each other. A pass already going is doing this one's work, so standing down is not a failure.
const standing = claimGate(join(root, "claim"));

if (standing !== null) {
  console.log(`Another pass is running, so this one stands down.\n${standing}`);
  process.exit(0);
}

process.on("exit", () => releaseGate(join(root, "claim")));

// The turns are read from one snapshot taken now, or the one named, as it stands (docs/gate-data.md, 「The
// conversation source」); what it could not read is said.
const named = lastOf(reading, "--snapshot");
const taken = named === undefined ? takeSnapshot() : null;

if (taken !== null) {
  process.on("exit", () => releaseSnapshot(taken));
}

const snapshot = taken ?? readSnapshot(named!);

if (snapshot === null) {
  console.error(`reference-data: ${named} is not a whole snapshot.`);
  process.exit(2);
}

for (const line of unavailableLines(snapshot)) {
  console.log(`reference-data: ${line}`);
}

const db = openSnapshot(taken?.path ?? join(named!, snapshotFile));
const ownerId = ownerIdFrom();
const agentId = agentIdFrom();
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
const names = pseudonyms("laya-real", { ownerId, agentId });

for (const [id, said] of people) {
  names.nameOf(id, said);
  names.idOf(id);
}

const who = { ownerId, names };
const built = readTurns(snapshotTurnReads(db, () => rooms, room), agentId);
const judge = asked(reading, "--no-judge") ? null : roads[roadName as keyof typeof roads]();
const health = asked(reading, "--no-laya") ? null : await layaHealth();

if (!asked(reading, "--no-laya") && health === null) {
  console.error("reference-data: the Laya service cannot be reached, so this pass does not ask it again.");
}

const report = await referenceTick({
  root,
  built,
  // The gate's own command builds the inputs, reading the units as they stand (docs/reference-data.md, 「The
  // input」).
  inputs: gateInputs(),
  road: judge?.road ?? null,
  ...judge === null ? {} : { judge: judge.judge },
  wanting,
  ...sources.length === 0 ? {} : { sources: sources.filter(isTurnSource) },
  judged: Number(lastOf(reading, "--judge") ?? judgedPerPass),
  atOnce: Math.max(1, Number(lastOf(reading, "--at-once") ?? "4")),
  messages: (turn) => {
    // A job's request is its requester's line, as its own run hands it to the gate; a search's question
    // stands as instructions instead.
    if (turn.work !== undefined) {
      return turn.work.kind === "job"
        ? [plainShapeLine({
          chatId: turn.chatId, messageId: 0, senderId: turn.work.requesterId, senderName: turn.work.requester, sentAt: turn.at,
          text: `${turn.work.title}\n${turn.work.instruction}`, imagePath: null, replyToMessageId: null,
        }, who)]
        : [];
    }

    const messages = room(turn.chatId);

    return turn.messageIds.flatMap((id) => messages.find((one) => one.messageId === id) ?? []).map((one) => plainShapeLine(one, who));
  },
  leaveText: (text) => leaveRoom(scrubText(text), names, people),
  leaveRequest: (request) => leaveRequest(request, names, people),
  laya: health === null ? null : {
    served: new Map([...servedCheckpoints(health)].filter(([gate]) => isReferenceGate(gate))),
    ask: async (gate, request) => layaAnswersOf(await layaDecide(gate, request)),
  },
  gateVersion: gateVersion(),
  snapshot: { takenAt: snapshot.takenAt },
  importFrom: lastOf(reading, "--import") ?? dataPath("reference-use", "use-1", "turns.jsonl"),
  say: (line) => console.log(line),
});

console.log(`written to ${root}/report.json: turns ${report.turns} · judged ${report.judgedTurns} turns in ${report.calls} batches · labels ${report.labels} · Laya asked ${report.layaAsked}, reused ${report.layaReused}`);

for (const gate of report.gates) {
  const figures = report.figures.find((one) => one.gate === gate.gate)!;
  const rows = gate.rows.train + gate.rows.calibration + gate.rows.test;

  console.log(`${gate.gate.padEnd(18)} rows ${rows} (waiting ${gate.waiting}) · yes ${gate.yes} · no ${gate.no} · contested ${gate.contested} · rows with a yes ${gate.rowsWithYes} · attached ${figures.attached} (used ${figures.used} · related ${figures.related} · unused ${figures.unused}) · missed turns ${figures.missTurns}`);
}

process.exit(report.failedBatches > 0 ? 1 : 0);
