import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { codexEffort, codexJudgeRoad, codexModel } from "../src/codex-road";
import { gateFor, judgePrompt, judgeSystem, judgedRows, readJudgements } from "../src/gate-judge";
import { j3090Effort, j3090JudgeRoad, j3090Model } from "../src/j3090-road";
import { languageOf, stateText } from "../src/laya-synth";
import {
  addTokens, freezeBatch, freezeSplits, gateOnDisk, guardFolder, keepBarrenAnswer, keepLostAnswer,
  noTokens, readProgress, roadHoldsSession, writeProgress,
} from "../src/laya-synth-run";
import { realMetaFile, unjudgedFile } from "../src/real-rows";
import { gateFolder, runFolder } from "../src/roots";

import type { JudgeRoad } from "../src/gate-judge";
import type { FrozenRow, SynthProgress, SynthRoad } from "../src/laya-synth-run";
import type { LayaState } from "../src/laya";
import type { RealMeta, UnjudgedRow } from "../src/real-rows";

// The judging pass over the rows real conversation gave (docs/gate-data.md, 「Judging the real
// rows」). Every label is made afresh here: the verdicts the record holds were given by gates whose
// prompts and structure have since moved, and a label nobody would give today is not a label.
//
// It writes into the same folders a generation writes, batch by batch, so the status, the merge,
// the verdict and the ledger read a judged gate exactly as they read a written one.

const usage = `usage: bun scripts/laya-judge.ts <실행> [--gate <게이트>]… [--road codex|j3090] [--batch <n>] [--at-once <n>] [--resume] [--overwrite] [--limit <n>]

실행 폴더의 게이트마다 unjudged.jsonl 을 읽어 지금 게이트 구조 그대로 판정하고, 묶음이 올 때마다 굳힌다.
<실행> 은 런타임 데이터 뿌리 아래의 이름이거나 절대 경로다. laya-real.ts 가 먼저 그 폴더를 채워야 한다.
--gate 는 게이트를 고른다(여러 번). 없으면 실행 폴더에 unjudged.jsonl 이 있는 게이트 전부.
--road 는 판정을 맡을 길(기본 codex). --batch 는 한 번에 판정시킬 행 수(기본 20).
--at-once 는 동시에 판정할 게이트 수(기본 1). --limit 은 게이트당 판정할 행 수, 연습 실행용.
--resume 은 굳은 묶음 다음부터 이어 간다. --overwrite 는 이미 굳은 폴더를 다시 쓴다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--gate": true, "--road": true, "--batch": true, "--at-once": true, "--limit": true,
  "--resume": false, "--overwrite": false,
});

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-judge: ${reading.trouble ?? "판정할 실행 하나를 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const root = runFolder(reading.loose[0]!);

if (!existsSync(join(root, realMetaFile))) {
  console.error(`laya-judge: ${root} 에 ${realMetaFile} 이 없습니다. bun scripts/laya-real.ts <실행> 을 먼저 돌리세요.`);
  process.exit(2);
}

const built = JSON.parse(readFileSync(join(root, realMetaFile), "utf8")) as RealMeta;
const roadName = (lastOf(reading, "--road") ?? "codex") as SynthRoad;

if (roadName !== "codex" && roadName !== "j3090") {
  console.error("laya-judge: --road 는 codex 나 j3090 입니다.");
  process.exit(2);
}

const road: JudgeRoad = roadName === "codex" ? codexJudgeRoad() : j3090JudgeRoad();
const model = roadName === "codex" ? codexModel : j3090Model;
const effort = roadName === "codex" ? codexEffort : j3090Effort;
const batchSize = Number(lastOf(reading, "--batch") ?? "20");
const atOnce = Math.max(1, Number(lastOf(reading, "--at-once") ?? "1"));
const limit = Number(lastOf(reading, "--limit") ?? "0");
const wanted = allOf(reading, "--gate");
const gates = (wanted.length === 0 ? built.gates : wanted)
  .filter((gate) => existsSync(join(gateFolder(root, gate), unjudgedFile)));

if (gates.length === 0) {
  console.error(`laya-judge: ${root} 에 판정할 행이 없습니다.`);
  process.exit(2);
}

const wants = { resume: asked(reading, "--resume"), overwrite: asked(reading, "--overwrite") };

function unjudgedOf(gate: string): UnjudgedRow[] {
  const rows = readFileSync(join(gateFolder(root, gate), unjudgedFile), "utf8")
    .split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as UnjudgedRow);

  return limit > 0 ? rows.slice(0, limit) : rows;
}

// One gate, batch by batch, resumed at the batch after the last one frozen. A batch that fails
// stops this gate and leaves what it froze standing; the others carry on.
async function judgeGate(gate: string): Promise<string | null> {
  const spec = gateFor(gate);
  const folder = gateFolder(root, gate);
  const rows = unjudgedOf(gate);
  const plan: UnjudgedRow[][] = Array.from(
    { length: Math.ceil(rows.length / batchSize) },
    (_, index) => rows.slice(index * batchSize, index * batchSize + batchSize),
  );
  const refusal = guardFolder(folder, wants);

  if (refusal !== null) {
    return refusal;
  }

  const held = wants.resume ? readProgress(folder) : null;
  const progress: SynthProgress = held ?? {
    started: new Date().toISOString(),
    model, effort, road: roadName, roads: [roadName],
    rows: built.limit, batchSize, shares: built.shares, gates: {},
  };
  const standing = progress.gates[gate] ?? {
    done: 0, sessionId: null, kept: 0, refused: {}, unreadable: 0, lostBatches: 0, tokens: noTokens,
  };

  progress.gates[gate] = standing;

  // What stands in the folder settles where the gate takes up, not the count a dead run kept of
  // itself: a run killed between freezing a batch and recording that it did would otherwise buy
  // that batch a second time and write the answer over rows that were already good.
  standing.done = Math.min(standing.done, gateOnDisk(folder, gate, plan.length).done);

  if (!roadHoldsSession(roadName)) {
    standing.sessionId = null;
  }

  for (let index = standing.done; index < plan.length; index += 1) {
    const batch = plan[index]!;
    const items = batch.map((row) => ({ id: row.id, state: row.state, questions: row.questions }));
    let answer: Awaited<ReturnType<JudgeRoad>>;

    try {
      answer = await road(judgeSystem, judgePrompt(spec, items), standing.sessionId);
    } catch (error) {
      return `${gate}: ${error instanceof Error ? error.message : String(error)}`;
    }

    standing.sessionId = answer.sessionId ?? standing.sessionId;
    standing.tokens = addTokens(standing.tokens, answer.tokens);

    const judged = readJudgements(answer.text, items);
    const outcome = judgedRows(spec, batch, judged, built.shares, "archive");

    if (judged.golds.size === 0) {
      standing.lostBatches += 1;
      keepLostAnswer(folder, gate, index, answer.text);
    } else if (outcome.rows.length === 0) {
      keepBarrenAnswer(folder, gate, index, answer.text);
    }

    const frozen: FrozenRow[] = outcome.rows.map((one) => ({
      row: one.row,
      language: languageOf(stateText(spec, JSON.parse(one.row.state) as LayaState)),
    }));

    freezeBatch(folder, gate, index, frozen);

    standing.done = index + 1;
    standing.kept += frozen.length;
    standing.unreadable += outcome.unanswered;

    for (const [why, many] of Object.entries(outcome.refusals)) {
      standing.refused[why] = (standing.refused[why] ?? 0) + many;
    }

    writeProgress(folder, progress);
    console.log(`${gate} ${index + 1}/${plan.length}: ${frozen.length}행 굳음, 못 읽은 항목 ${outcome.unanswered}.`);
  }

  const meta = freezeSplits(folder, progress);

  console.log(`${gate}: 끝. ${meta.gates[0]?.rows ?? 0}행.`);

  return null;
}

const trouble: string[] = [];

for (let start = 0; start < gates.length; start += atOnce) {
  const said = await Promise.all(gates.slice(start, start + atOnce).map((gate) => judgeGate(gate)));

  trouble.push(...said.filter((one): one is string => one !== null));
}

if (trouble.length > 0) {
  console.error(trouble.join("\n"));
  process.exit(1);
}
