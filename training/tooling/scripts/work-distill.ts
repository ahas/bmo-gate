import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentIdFrom, ownerIdFrom } from "../src/conversation";
import { openSnapshot, readSnapshot, releaseSnapshot, snapshotFile, takeSnapshot, unavailableLines } from "../src/snapshot";
import { claudeAccount, claudeEffort, claudeJudgeRoad, claudeModel } from "../src/claude-road";
import { asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { claimGate, releaseGate } from "../src/gate-claim";
import { addTokens, noTokens } from "../src/laya-synth-run";
import { pseudonyms, scrubText } from "../src/pii";
import {
  appendDistilledLabels, snapshotWorks, askOf, distilledGate, meanLabels, readDistilledLabels, readTeaching, samples, selfAgreement, taughtWork,
  teachBatches, teachPrompt, teacherSystem, trainingSplit, untaught, wantedSamples, worksPerBatch,
} from "../src/reference/distill";
import { gateInputs, gateVersion } from "../src/reference/live-inputs";
import { leaveRequest, leaveRoom, referenceRows } from "../src/reference/rows";
import { writeGates } from "../src/reference/tick";
import { dataPath, refuseInsideCheckout } from "../src/roots";

import type { TaughtPiece, TaughtWork, WorkInput } from "../src/reference/distill";
import type { LiveTurn } from "../src/reference/live-inputs";

// One run of the knowledge gate's distilled work labels (docs/reference-data.md, 「Distilled work labels」).

const usage = `usage: bun scripts/work-distill.ts <run> [--teach <n>] [--batch <n>] [--at-once <n>] [--snapshot <folder>] [--with <reference run>] [--no-teach]

Distils the knowledge gate's labels for work: every item, job text and search question a conversation snapshot
holds, the knowledge gate's input the gate's own code builds for each, and the teacher on the claude road (the
Claude login the settings name, ${claudeModel} ${claudeEffort}) asked which offered pieces each one needs, with its
probability and its reason. Rows are assembled afresh from every label into gates/ under the run.
<run> is a name under the data root's work-distill/ or an absolute path.
--teach bounds how many works this run teaches (default every one still wanting a label); --batch is the works per
call (default ${worksPerBatch}); --at-once the calls at once (default 3). --snapshot reads a kept snapshot as it
stands instead of taking one. The inputs are built by the gate's command the settings name as gate_command.
--with names the reference run whose knowledge-gate rows the training folder training/ is made with (default ref-1).
--no-teach assembles the rows from the labels standing and teaches nothing.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--teach": true, "--batch": true, "--at-once": true, "--snapshot": true, "--with": true, "--no-teach": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`work-distill: ${reading.trouble ?? "name one run."}`);
  console.error(usage);
  process.exit(2);
}

const name = reading.loose[0]!;
const root = name.startsWith("/") ? name : dataPath("work-distill", name);
const refusal = refuseInsideCheckout(root);

if (refusal !== null) {
  console.error(refusal);
  process.exit(2);
}

mkdirSync(join(root, "taught"), { recursive: true });

const standing = claimGate(join(root, "claim"));

if (standing !== null) {
  console.log(`another run of ${root} is going; this one stands down.\n${standing}`);
  process.exit(0);
}

process.on("exit", () => releaseGate(join(root, "claim")));

const named = lastOf(reading, "--snapshot");
const taken = named === undefined ? takeSnapshot() : null;

if (taken !== null) {
  process.on("exit", () => releaseSnapshot(taken));
}

const snapshot = taken ?? readSnapshot(named!);

if (snapshot === null) {
  console.error(`work-distill: ${named} is not a whole snapshot.`);
  process.exit(2);
}

for (const line of unavailableLines(snapshot)) {
  console.log(`work-distill: ${line}`);
}

const db = openSnapshot(taken?.path ?? join(named!, snapshotFile));
const ownerId = ownerIdFrom();
const agentId = agentIdFrom();
// The same stand-ins every reference pass gives, so a person is one stand-in across both kinds of rows.
const people = new Map((db.query(`SELECT sender_id AS id, sender_name AS name FROM messages WHERE sender_id IS NOT NULL
    GROUP BY sender_id ORDER BY sender_id`).all() as { id: number; name: string }[]).map((one) => [one.id, one.name]));
const names = pseudonyms("laya-real", { ownerId, agentId });

for (const [id, said] of people) {
  names.nameOf(id, said);
  names.idOf(id);
}

const leaveText = (text: string): string => leaveRoom(scrubText(text), names, people);
const works = snapshotWorks(db);
const inputs = gateInputs();
const live = inputs(works.map(askOf));

console.log(`works ${works.length} · inputs ${live.length}`);

// The pieces each room's works are offered, read once per room with their bodies.
const piecesOf = new Map<number, TaughtPiece[]>();

for (const chatId of new Set(works.map((one) => one.chatId))) {
  const slugs = [...new Set(live.flatMap((turn) => turn.chatId === chatId ? turn.gates.filter((gate) => gate.gate === distilledGate).flatMap((gate) => gate.candidates.map((one) => one.slug)) : []))];

  if (slugs.length === 0) {
    continue;
  }

  const [answer] = inputs([{ chatId, messageIds: [], work: { kind: "search", query: "library" }, bodies: { [distilledGate]: slugs } }]);

  piecesOf.set(chatId, (answer?.pieces ?? []).filter((one) => one.body !== null).map((one) => ({ slug: one.slug, line: leaveText(`${one.slug}: ${one.about ?? ""}`), body: leaveText(one.body!) })));
}

const taught = works.flatMap((work, index): (TaughtWork & { chatId: number; input: LiveTurn; work: WorkInput })[] => {
  const one = taughtWork(work, live[index]!, leaveText);

  return one === null ? [] : [{ ...one, chatId: work.chatId, input: live[index]!, work }];
});
const labelsPath = join(root, "labels.jsonl");
const labels = readDistilledLabels(labelsPath);
const wanting = untaught(taught, labels).slice(0, Number(lastOf(reading, "--teach") ?? Number.MAX_SAFE_INTEGER));
const chatOf = new Map(taught.map((one) => [one.id, one.chatId]));
const plan = asked(reading, "--no-teach")
  ? []
  : teachBatches(wanting.map((one) => ({ id: one.id, kind: one.kind, requester: one.requester, request: one.request, candidates: one.candidates, chatId: one.chatId })),
    Number(lastOf(reading, "--batch") ?? worksPerBatch));
const road = claudeJudgeRoad({});
const judge = `claude ${claudeModel} ${claudeEffort} ${claudeAccount()}`;
const base = [...labels.values()].flatMap((given) => [...given.values()]).reduce((next, one) => typeof one.batch === "number" ? Math.max(next, one.batch + 1) : next, 0);
const spent = { calls: 0, failed: 0, tokens: noTokens };

console.log(`taught works ${taught.length} · wanting ${wanting.length} · batches ${plan.length} · teacher ${judge}`);

// Each sample of a batch is its own call, asked without the others in sight; a batch asks only the
// samples its works still want.
const teach = async (batch: TaughtWork[], index: number): Promise<void> => {
  const pieces = piecesOf.get(chatOf.get(batch[0]!.id)!) ?? [];
  const wanted = [...new Set(batch.flatMap((one) => wantedSamples(one, labels)))].sort();

  await Promise.all(wanted.map(async (sample) => {
    try {
      const answer = await road(teacherSystem, teachPrompt(batch, pieces), null);
      const read = readTeaching(answer.text, batch, base + index, new Date().toISOString(), sample);

      writeFileSync(join(root, "taught", `${String(base + index).padStart(5, "0")}-${sample}.json`), `${JSON.stringify({ judge, sample, works: batch, answer: answer.text, tokens: answer.tokens, labels: read })}\n`);
      appendDistilledLabels(labelsPath, read);
      spent.tokens = addTokens(spent.tokens, answer.tokens);
      spent.calls += 1;
      console.log(`batch ${index + 1}/${plan.length} sample ${sample}: ${read.length} labels`);
    } catch (error) {
      spent.failed += 1;
      console.log(`batch ${index + 1}/${plan.length} sample ${sample} failed: ${(error as Error).message}`);
    }
  }));
};

// A failed batch ends the teaching: the ones under way land and no further batch starts, so a spent
// limit is met once.
const atOnce = Math.max(1, Number(lastOf(reading, "--at-once") ?? "3"));

for (let next = 0; next < plan.length && spent.failed === 0; next += atOnce) {
  await Promise.all(plan.slice(next, next + atOnce).map((batch, offset) => teach(batch, next + offset)));
}

const standingLabels = readDistilledLabels(labelsPath);
const meant = meanLabels(standingLabels);
const built = referenceRows(
  taught.map((one) => ({ key: one.id, source: "work" as const, gates: one.input.gates.filter((gate) => gate.gate === distilledGate) })),
  meant,
  (request) => leaveRequest(request, names, people),
);
const gates = writeGates(root, built);
const report = {
  at: new Date().toISOString(),
  gateVersion: gateVersion(),
  snapshot: { takenAt: snapshot.takenAt },
  judge,
  works: works.length,
  taught: taught.length,
  samples,
  labels: meant.size,
  needed: [...meant.values()].filter((one) => one.word === "needed").length,
  selfAgreement: selfAgreement(standingLabels),
  calls: spent.calls,
  failed: spent.failed,
  tokens: spent.tokens,
  gate: gates.find((one) => one.gate === distilledGate),
};

// The training folder: the reference run's rows with the distilled work rows in place of its own in training and
// calibration, and its test kept; the distilled test rows beside it.
const withRun = lastOf(reading, "--with") ?? "ref-1";
const referenceGate = join(withRun.startsWith("/") ? withRun : dataPath("reference-data", withRun), "gates", distilledGate);
const distilledRows = join(root, "gates", distilledGate);
const rowsOf = (folder: string, split: string) => {
  const file = join(folder, `${split}.jsonl`);

  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as { id: string; turn: string; stratum?: string }) : [];
};
const taughtKeys = new Set(taught.map((one) => one.id));
const training = join(root, "training");

mkdirSync(training, { recursive: true });

for (const split of ["train", "calibration", "test"] as const) {
  const rows = trainingSplit(split, rowsOf(referenceGate, split), rowsOf(distilledRows, split), taughtKeys);

  writeFileSync(join(training, `${split}.jsonl`), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

writeFileSync(join(root, "distilled-test.jsonl"), rowsOf(distilledRows, "test").map((row) => `${JSON.stringify(row)}\n`).join(""));
writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
process.exit(spent.failed > 0 ? 1 : 0);
