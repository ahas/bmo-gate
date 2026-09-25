import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { claudeEffort, claudeJudgeRoad, claudeModel } from "../src/claude-road";
import { codexEffort, codexJudgeRoad, codexModel } from "../src/codex-road";
import { answersPerBatch, gateFor, judgeBatches, judgePrompt, judgeSystem, judgedRows, readJudgements } from "../src/gate-judge";
import { j3090Effort, j3090JudgeRoad, j3090Model } from "../src/j3090-road";
import { languageOf, stateText } from "../src/laya-synth";
import {
  addTokens, freezeBatch, freezeSplits, frozenState, gateOnDisk, guardFolder, keepBarrenAnswer,
  keepLostAnswer, noTokens, readProgress, writeProgress,
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

const usage = `usage: bun scripts/laya-judge.ts <실행> [--gate <게이트>]… [--road codex|j3090|claude] [--batch <n>] [--answers <n>] [--at-once <n>] [--resume] [--overwrite] [--limit <n>]

실행 폴더의 게이트마다 unjudged.jsonl 을 읽어 지금 게이트 구조 그대로 판정하고, 묶음이 올 때마다 굳힌다.
<실행> 은 런타임 데이터 뿌리 아래의 이름이거나 절대 경로다. laya-real.ts 가 먼저 그 폴더를 채워야 한다.
--gate 는 게이트를 고른다(여러 번). 없으면 실행 폴더에 unjudged.jsonl 이 있는 게이트 전부.
--road 는 판정을 맡을 길(기본 codex). claude 는 2번 Claude 계정(~/.claude)에 못박힌 claude-sonnet-5 high 이다. --batch 는 한 묶음의 최대 행 수(기본 20).
--answers 는 한 묶음이 물을 수 있는 최대 답 수(기본 ${answersPerBatch}). 후보마다 질문이 붙는 게이트는 이쪽이 묶음을 정한다.
--at-once 는 동시에 판정할 게이트 수(기본 1). --limit 은 게이트당 판정할 행 수, 연습 실행용.
--resume 은 굳은 묶음 다음부터 이어 간다. --overwrite 는 이미 굳은 폴더를 다시 쓴다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--gate": true, "--road": true, "--batch": true, "--answers": true, "--at-once": true, "--limit": true,
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

// What each road judges with: the road itself, and the model and effort recorded beside its batches.
const roads: Record<SynthRoad, () => { road: JudgeRoad; model: string; effort: string }> = {
  codex: () => ({ road: codexJudgeRoad(), model: codexModel, effort: codexEffort }),
  j3090: () => ({ road: j3090JudgeRoad(), model: j3090Model, effort: j3090Effort }),
  claude: () => ({ road: claudeJudgeRoad(), model: claudeModel, effort: claudeEffort }),
};

if (!Object.hasOwn(roads, roadName)) {
  console.error(`laya-judge: --road 는 ${Object.keys(roads).join(", ")} 중 하나입니다.`);
  process.exit(2);
}

const { road, model, effort } = roads[roadName]();
const batchSize = Number(lastOf(reading, "--batch") ?? "20");
const answerCap = Number(lastOf(reading, "--answers") ?? String(answersPerBatch));
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
  const plan = judgeBatches(rows, batchSize, answerCap);
  const refusal = guardFolder(folder, wants);

  if (refusal !== null) {
    // A gate whose folder already holds its three splits is a gate that finished, and a run told to
    // take up where it left off has nothing to take up in it. That is not trouble: counting it as
    // trouble ends every later run of the set in failure over work that is done, and the unit
    // carrying the run restarts for ever on the strength of it.
    if (wants.resume && frozenState(folder) === "frozen") {
      console.log(`${gate}: 이미 끝났습니다.`);

      return null;
    }

    return refusal;
  }

  const held = wants.resume ? readProgress(folder) : null;

  // The plan is a pure function of the rows and the two bounds, so a resume under bounds the frozen
  // batches were not cut to — or over rows built since they were cut — would take up at a batch
  // holding other rows than the one it counted, and the rows between the two plans would be left
  // unjudged with nothing saying so.
  if (held !== null && (held.batchSize !== batchSize || (held.answerCap ?? answerCap) !== answerCap)) {
    return `${gate}: 굳은 묶음은 --batch ${held.batchSize} --answers ${held.answerCap ?? answerCap} 로 잘렸습니다. 같은 값으로 이어 가거나 --overwrite 로 다시 쓰세요.`;
  }

  if (held !== null && held.builtAt !== undefined && held.builtAt !== built.built) {
    return `${gate}: 굳은 묶음은 ${held.builtAt} 에 세운 행에서 잘렸고 지금 행은 ${built.built} 에 세운 것입니다. --overwrite 로 다시 쓰세요.`;
  }

  const progress: SynthProgress = held ?? {
    started: new Date().toISOString(),
    model, effort, road: roadName, roads: [roadName],
    rows: built.limit, batchSize, answerCap, builtAt: built.built, shares: built.shares, gates: {},
  };
  const standing = progress.gates[gate] ?? {
    done: 0, sessionId: null, kept: 0, refused: {}, unreadable: 0, lostBatches: 0, tokens: noTokens,
  };

  progress.gates[gate] = standing;

  // What stands in the folder settles where the gate takes up, not the count a dead run kept of
  // itself: a run killed between freezing a batch and recording that it did would otherwise buy
  // that batch a second time and write the answer over rows that were already good.
  standing.done = Math.min(standing.done, gateOnDisk(folder, gate, plan.length).done);

  // A judging batch carries no fixed prefix worth holding a thread for — the system prompt is a few
  // lines and the gate's own is a few more, and everything else in the ask is that batch's own rows,
  // which are never sent twice. So a held thread buys nothing here and costs the whole conversation
  // back on every batch, until the thread fills the model's context window and the gate dies of it.
  standing.sessionId = null;

  for (let index = standing.done; index < plan.length; index += 1) {
    const batch = plan[index]!;
    const items = batch.map((row) => ({ id: row.id, state: row.state, questions: row.questions }));
    let answer: Awaited<ReturnType<JudgeRoad>>;

    try {
      answer = await road(judgeSystem, judgePrompt(spec, items), null);
    } catch (error) {
      return `${gate}: ${index + 1}/${plan.length} 에서 섰습니다 — ${error instanceof Error ? error.message : String(error)}`;
    }

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

// A gate that falls says so the moment it falls. The gates beside it run for hours yet, and a
// failure held back until every one of them is finished is a failure nobody sees all day — which
// is exactly how five gates stood dead in a run that looked, from its log, to be going fine.
async function runGate(gate: string): Promise<void> {
  const said = await judgeGate(gate);

  if (said !== null) {
    console.error(said);
    trouble.push(said);
  }
}

// As many gates judging at once as the run asked for, and a gate that finishes is replaced rather
// than waited on. Cutting the roster into fixed groups instead leaves the whole run standing on the
// slowest gate of each group: a gate of six thousand batches and a gate of eighty are not two
// halves of anything, and the ones that finished sit idle beside the one that has not.
const waiting = [...gates];

async function takeGates(): Promise<void> {
  for (let gate = waiting.shift(); gate !== undefined; gate = waiting.shift()) {
    await runGate(gate);
  }
}

await Promise.all(Array.from({ length: Math.min(atOnce, gates.length) }, () => takeGates()));

if (trouble.length > 0) {
  process.exit(1);
}
