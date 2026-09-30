import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  answeredModels, downgradeNotices, launchedModels, openArchive, sanitisedBetween, turnsAnsweredBy,
} from "../src/archive";
import { releaseArchiveCopy, takeArchiveCopy } from "../src/archive-copy";
import { claudeEffort, claudeJudgeRoad, claudeModel } from "../src/claude-road";
import { codexEffort, codexJudgeRoad, codexModel } from "../src/codex-road";
import { allOf, asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { gateFor, judgeBatches, judgePrompt, judgeSystem, judgedRows, readJudgements } from "../src/gate-judge";
import { j3090Effort, j3090JudgeRoad, j3090Model } from "../src/j3090-road";
import {
  candidatesOf, defaultClusterSeconds, defaultWindowSeconds, downgradeEvents, eventKey, eventOutcome,
  fallbackModels, keptAs, windowTexts,
} from "../src/laya-downgrade";
import { splitFiles } from "../src/laya-frozen";
import { sanitizerGate } from "../src/laya-sanitize";
import { languageOf, stateText } from "../src/laya-synth";
import {
  addTokens, batchesFolder, freezeBatch, freezeSplits, guardFolder, languageFile, noTokens, readFrozenBatches, readProgress,
  writeProgress,
} from "../src/laya-synth-run";
import { gateFolder, refuseInsideCheckout, runFolder } from "../src/roots";

import type { Candidate, DowngradeEvent } from "../src/laya-downgrade";
import type { DatasetRow, Gold, SplitShares } from "../src/laya-dataset";
import type { JudgeRoad } from "../src/gate-judge";
import type { LayaState } from "../src/laya";
import type { LanguageBucket } from "../src/laya-synth";
import type { FrozenRow, SynthProgress, SynthRoad } from "../src/laya-synth-run";
import type { UnjudgedRow } from "../src/real-rows";

// The downgrade harvest (docs/gate-data.md, 「The downgrade harvest」): sanitiser rows made of the
// material the account safeguard balked at. It reads a copy of BMO's archive, finds the downgrades,
// gathers the passed-through context standing before each, offers every passage of it to the gate's
// own question on a road, and freezes the rows worth keeping as a sanitiser gate folder a training
// pass takes in as a top-up. No worker and no person reads the harmful body: it streams past the judge
// and freezes, and only counts, outcomes and paths are said. Each downgrade's outcome lands in the
// run's live.txt as it is settled, which is 하스's to watch; the worker reads the counts alone.

const usage = `usage: bun scripts/laya-downgrade.ts [--run <이름>] [--road codex|j3090|claude|n5] [--node <n2|n3|n4|n5>]…
                                    [--window <초>] [--cluster <초>] [--limit <n>]
                                    [--batch <n>] [--answers <n>] [--db <경로>]
                                    [--calibration <비율>] [--test <비율>] [--resume] [--freeze-only] [--overwrite]

강등된 대화를 모아 무해화 게이트(sanitizer) 추가 학습 데이터로 만든다. 강등은 계정 세이프가드가 세션
맥락에 걸려 더 낮은 모델로 실행한 것이고, 그 맥락이 곧 게이트가 놓친 입력이다. 아카이브 사본에서 강등을
찾아 직전 맥락(무해화 게이트를 지난 뒤의 글)을 모으고, 모든 구간을 길에서 판정한다.
유해로 판정된 구간은 DEFUSE, 무해인데 공격 어휘가 있는 구간은 CLEAN으로 남기고, 어휘 없는 무해 구간은
판정 기록에만 적는다. 강등마다 유해 구간이 있으면 유해, 없고 공격 어휘가 있으면 과잉 반응, 둘 다 없으면 원인 불명이다.
--run 을 주면 그 실행 폴더의 gates/sanitizer 에 굳히고, 안 주면 세기만 한다(판정 없음).
--road 는 판정을 맡을 길(기본 n5). 세이프가드를 낳은 계정 대신 집 모델로 판정한다.
--node 는 n5 길에서 판정에 쓸 텍스트 모델 노드. 없으면 답하는 노드를 모두 나눠 쓴다.
--window 는 강등 직전 몇 초까지 거슬러 맥락을 모을지(기본 ${defaultWindowSeconds}).
--cluster 는 같은 방의 강등을 한 건으로 묶는 간격(기본 ${defaultClusterSeconds}).
--limit 은 판정할 구간 수 상한(연습용). --batch 와 --answers 는 한 묶음의 상한.
--db 는 읽을 아카이브 파일, 없으면 비모 아카이브의 사본을 새로 떠서 읽는다.
--resume 은 이미 굳은 데이터의 구간은 건너뛰고 아직 판정 못 한 구간부터 이어서 판정한다.
--freeze-only 는 판정 없이 이미 굳은 구간만 데이터셋으로 정리한다(길을 쓰지 않는다).
--overwrite 는 폴더를 비우고 처음부터 다시 쓴다.

강등마다의 방·시각·결과(유해/과잉 반응/원인 불명)가 실행 폴더의 live.txt 에 실행이 끝날 때 적힌다(본문은 안 쓴다).
추가 학습에 넣으려면: bun scripts/laya-train.ts <본실행> --gate sanitizer --top-up <이 실행>`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--run": true, "--road": true, "--node": true, "--window": true, "--cluster": true, "--limit": true,
  "--batch": true, "--answers": true, "--db": true, "--calibration": true, "--test": true,
  "--resume": false, "--freeze-only": false, "--overwrite": false,
});

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-downgrade: ${reading.trouble ?? `${reading.loose.join(" ")} 는 무엇인지 모르겠습니다.`}`);
  console.error(usage);
  process.exit(2);
}

const runName = lastOf(reading, "--run");
const root = runName === undefined ? null : runFolder(runName);

if (root !== null) {
  const inside = refuseInsideCheckout(root);

  if (inside !== null) {
    console.error(`laya-downgrade: ${inside}`);
    process.exit(2);
  }
}

const shares: SplitShares = {
  calibration: Number(lastOf(reading, "--calibration") ?? "0.15"),
  test: Number(lastOf(reading, "--test") ?? "0.15"),
};
const windowSeconds = Number(lastOf(reading, "--window") ?? String(defaultWindowSeconds));
const clusterSeconds = Number(lastOf(reading, "--cluster") ?? String(defaultClusterSeconds));
const limit = Number(lastOf(reading, "--limit") ?? "0");
// A candidate passage runs to the edge of one Laya call, so a batch of them is a long ask, and the
// home model that judges it drops rows out of a large batch's answer. A small batch is what it
// answers whole, so the harvest asks for few at a time; attribution is by row id, so the batch size
// costs only wall-clock, not which downgrade a verdict belongs to.
const batchSize = Number(lastOf(reading, "--batch") ?? "2");
const answerCap = Number(lastOf(reading, "--answers") ?? "100");
const roadName = (lastOf(reading, "--road") ?? "n5") as SynthRoad;

const wantedNodes = allOf(reading, "--node");

// Each road gives the judges a batch is handed to, one batch in hand a judge. The account roads are
// one judge; the n5 road is one a text-model node that answers its health, so the batches spread
// over n2 to n5. Its builder is loaded only when a road is actually driven, so a dry count needs
// nothing standing on the nodes.
interface Judges { judges: Array<{ name: string; road: JudgeRoad }>; model: string; effort: string }

const roads: Record<SynthRoad, () => Promise<Judges>> = {
  codex: async () => ({ judges: [{ name: "codex", road: codexJudgeRoad() }], model: codexModel, effort: codexEffort }),
  j3090: async () => ({ judges: [{ name: "j3090", road: j3090JudgeRoad() }], model: j3090Model, effort: j3090Effort }),
  claude: async () => ({ judges: [{ name: "claude", road: claudeJudgeRoad() }], model: claudeModel, effort: claudeEffort }),
  n5: async () => {
    const { TEXT_NODES } = await import("../src/n5-llm-install");
    const { n5Effort, n5JudgeRoadFor, n5Model, readyTextNodes } = await import("../src/n5-road");
    const { ready, dropped } = await readyTextNodes(wantedNodes.length > 0 ? wantedNodes : [...TEXT_NODES]);

    for (const [node, why] of dropped) {
      console.log(`노드 ${node} 는 빠집니다: ${why}`);
    }

    console.log(`판정 노드: ${ready.length === 0 ? "없음" : ready.join(", ")}`);

    return { judges: ready.map((node) => ({ name: node, road: n5JudgeRoadFor(node) })), model: n5Model, effort: n5Effort };
  },
};

if (!Object.hasOwn(roads, roadName)) {
  console.error(`laya-downgrade: --road 는 ${Object.keys(roads).join(", ")} 중 하나입니다.`);
  process.exit(2);
}

// A file named is read as it stands; otherwise a copy of BMO's archive is taken for this run and the
// live one is never opened (docs/gate-data.md, 「The archive copy」).
const named = lastOf(reading, "--db");
const copy = named === undefined ? takeArchiveCopy() : null;

if (copy !== null) {
  process.on("exit", () => releaseArchiveCopy(copy));
}

const db = openArchive(named ?? copy!.path);

// A model that only ever answers and is never launched is a safeguard's fallback; a turn it answered
// is a downgraded turn (docs/gate-data.md, 「The downgrade harvest」).
const fallbacks = fallbackModels(launchedModels(db), answeredModels(db));
const notices = downgradeNotices(db);
const turns = turnsAnsweredBy(db, fallbacks);
const events = downgradeEvents(notices, turns, clusterSeconds);

console.log(`세이프가드 폴백 모델: ${fallbacks.length === 0 ? "없음" : fallbacks.join(", ")}`);
console.log(`강등 ${events.length}건 (알림 ${notices.length}, 폴백으로 답한 턴 ${turns.length}).`);

// Each downgrade's candidates, and the id of every candidate row it gave, so an outcome can be read
// per downgrade once the rows are judged. A passage that stands in more than one window is one row
// judged once, but it counts towards every downgrade whose window held it.
const rowsById = new Map<string, UnjudgedRow>();
const adjacent = new Set<string>();
const keysByEvent = new Map<string, string[]>();
const eventOf = new Map<string, DowngradeEvent>();

for (const event of events) {
  const window = sanitisedBetween(db, event.at - windowSeconds, event.at);
  const candidates: Candidate[] = candidatesOf(event, windowTexts(event, window, windowSeconds), shares);
  const key = eventKey(event);

  eventOf.set(key, event);
  keysByEvent.set(key, candidates.map((one) => one.row.id));

  for (const one of candidates) {
    if (one.adjacent) {
      adjacent.add(one.row.id);
    }

    if (limit > 0 && rowsById.size >= limit && !rowsById.has(one.row.id)) {
      continue;
    }

    rowsById.set(one.row.id, one.row);
  }
}

const uniqueRows = [...rowsById.values()];
const withAdjacent = [...keysByEvent.values()].filter((ids) => ids.some((id) => adjacent.has(id))).length;
const emptyWindows = [...keysByEvent.values()].filter((ids) => ids.length === 0).length;

console.log(`판정할 구간 ${uniqueRows.length}개(공격 어휘 ${uniqueRows.filter((row) => adjacent.has(row.id)).length}개), 공격 어휘가 있는 강등 ${withAdjacent}건, 맥락이 비어 있는 강등 ${emptyWindows}건.`);

if (root === null) {
  console.log("굳히려면 실행 이름을 주세요: bun scripts/laya-downgrade.ts --run <이름>");
  process.exit(0);
}

if (uniqueRows.length === 0) {
  console.error("laya-downgrade: 강등 직전 맥락에 판정할 구간이 없어 굳힐 것이 없습니다.");
  process.exit(1);
}

const spec = gateFor(sanitizerGate);
const folder = gateFolder(root, sanitizerGate);
const wantResume = asked(reading, "--resume");
const wantFreezeOnly = asked(reading, "--freeze-only");
const wantOverwrite = asked(reading, "--overwrite");

// A fresh run refuses to clobber a folder that already holds data. Resume and freeze-only mean to
// read that data and build on it, and overwrite means to throw it away, so those three say outright
// what to do with what stands rather than being refused it.
if (!wantResume && !wantFreezeOnly && !wantOverwrite) {
  const refusal = guardFolder(folder, { resume: false, overwrite: false });

  if (refusal !== null) {
    console.error(`laya-downgrade: ${refusal}\n--resume 로 못 한 구간부터 이어 가거나, --freeze-only 로 굳은 것만 정리하거나, --overwrite 로 다시 쓰세요.`);
    process.exit(2);
  }
}

if (wantOverwrite) {
  rmSync(folder, { recursive: true, force: true });
}

mkdirSync(folder, { recursive: true });

// The judges are raised only when there is judging to do, so a freeze and a pass with nothing new
// touch no road; until then the folder keeps the model it was judged with.
const past = readProgress(folder);
let judges: Judges["judges"] = [];

const progress: SynthProgress = {
  started: new Date().toISOString(),
  model: past?.model ?? "none", effort: past?.effort ?? "none", road: roadName, roads: [roadName],
  rows: uniqueRows.length, batchSize, answerCap, shares, gates: {},
};
const standing = { done: 0, sessionId: null, kept: 0, refused: {}, unreadable: 0, lostBatches: 0, tokens: noTokens };

progress.gates[sanitizerGate] = standing;

// Every verdict the judge gave, kept or not, one line a passage, appended as each batch lands. The
// splits hold only the kept rows, so this is what tells a resume a clean passage without the
// vocabulary was already judged (docs/gate-data.md, 「Resuming the harvest」).
const judgedFile = "judged.jsonl";
const judgedPath = join(folder, judgedFile);

const harmful = new Set<string>();
const judged = new Set<string>();
let defuseRows = 0;
let cleanRows = 0;
let nextBatch = 0;

// The rows a past run already judged, read back so a resume skips them and settles only what is left
// (docs/gate-data.md, 「Resuming the harvest」). The frozen splits are the authoritative dataset; the
// raw batches are read only where a run stopped before it froze them. A stopped run may have left an
// inconsistent mix of batches, so the seeded rows are rewritten as one consolidation batch and the
// old batches cleared, leaving the frozen batches in step with the saved dataset.
function seedFromExisting(): void {
  const haveSplits = Object.values(splitFiles).some((name) => existsSync(join(folder, name)));
  const languages = new Map<string, LanguageBucket>();
  const languagePath = join(folder, languageFile);

  if (haveSplits && existsSync(languagePath)) {
    for (const line of readFileSync(languagePath, "utf8").split("\n").filter((one) => one.trim() !== "")) {
      const one = JSON.parse(line) as { id: string; language: LanguageBucket };

      languages.set(one.id, one.language);
    }
  }

  const saved: FrozenRow[] = Object.values(splitFiles).flatMap((name) => {
    const path = join(folder, name);

    if (!existsSync(path)) {
      return [];
    }

    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => {
      const row = JSON.parse(line) as DatasetRow;

      return { row, language: languages.get(row.id) ?? languageOf(stateText(spec, JSON.parse(row.state) as LayaState)) };
    });
  });
  const savedIds = new Set(saved.map((one) => one.row.id));

  // A run stopped before its end froze kept rows into batches its splits never took in, and the verdict
  // record already names them judged, so the batches' rows join the saved ones rather than being
  // cleared with the batches.
  const existing: FrozenRow[] = [...saved, ...readFrozenBatches(folder).filter((one) => !savedIds.has(one.row.id))];

  for (const one of existing) {
    judged.add(one.row.id);

    const gold = JSON.parse(one.row.gold) as Gold;

    if (gold.type === "noul" && gold.label === "true") {
      harmful.add(one.row.id);
      defuseRows += 1;
    } else {
      cleanRows += 1;
    }
  }

  const notKept = existsSync(judgedPath)
    ? readFileSync(judgedPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as { id: string; harmful: boolean })
    : [];

  for (const one of notKept) {
    judged.add(one.id);

    if (one.harmful) {
      harmful.add(one.id);
    }
  }

  rmSync(join(folder, batchesFolder), { recursive: true, force: true });

  if (existing.length > 0) {
    freezeBatch(folder, sanitizerGate, 0, existing);
    nextBatch = 1;
  }

  console.log(`이미 판정된 ${judged.size}개를 이어받았습니다 (남긴 행 ${existing.length}, 유해 ${harmful.size}).`);
}

if (wantResume || wantFreezeOnly) {
  seedFromExisting();
}

// How many extra rounds re-ask the rows the judge left unread. The home model drops rows out of a
// batch's answer, so a row unread in one batch is asked again on its own, where the model answers it
// whole; a few rounds settle almost all of them, and what is still unread after is counted, never
// guessed at — a passage the judge never read is not a passage it found clean.
const retryRounds = 3;

// One batch on one judge: asked, read, its verdicts recorded, and the passages worth keeping frozen.
async function judgeBatch(judge: Judges["judges"][number], batch: readonly UnjudgedRow[]): Promise<void> {
  const items = batch.map((row) => ({ id: row.id, state: row.state, questions: row.questions }));
  let answer: Awaited<ReturnType<JudgeRoad>>;

  try {
    answer = await judge.road(judgeSystem, judgePrompt(spec, items), null);
  } catch (error) {
    // A road that fails a batch after its own retries stops that batch, not the run: the rows
    // stay unread and are asked again in a retry round or counted, so one busy stretch of a shared
    // card never throws away the batches already frozen.
    console.error(`laya-downgrade: ${judge.name} 의 묶음 판정 실패, 건너뜁니다 — ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  standing.tokens = addTokens(standing.tokens, answer.tokens);

  const reading = readJudgements(answer.text, items);
  const verdicts: string[] = [];

  // The sanitiser asks one question of a row, so a row's one gold is its verdict: a gold read as
  // harmful marks the passage a DEFUSE and the downgrade it came from as harmful, and any gold read
  // at all marks the row read so neither a retry nor a resume asks it again.
  for (const [id, golds] of reading.golds) {
    const gold = Object.values(golds)[0];
    const isHarmful = gold !== undefined && gold.type === "noul" && gold.label === "true";

    judged.add(id);

    if (isHarmful) {
      harmful.add(id);
    }

    verdicts.push(JSON.stringify({ id, harmful: isHarmful }));
  }

  const outcome = judgedRows(spec, batch, reading, shares, "archive");
  const frozen: FrozenRow[] = outcome.rows.flatMap((one) => {
    const kept = keptAs(harmful.has(one.row.id), adjacent.has(one.row.id));

    if (kept === null) {
      return [];
    }

    if (kept === "DEFUSE") {
      defuseRows += 1;
    } else {
      cleanRows += 1;
    }

    return [{ row: one.row, language: languageOf(stateText(spec, JSON.parse(one.row.state) as LayaState)) }];
  });

  // The index is taken as the batch lands, so judges answering side by side never share one.
  const index = nextBatch;

  nextBatch += 1;
  freezeBatch(folder, sanitizerGate, index, frozen);

  if (verdicts.length > 0) {
    appendFileSync(judgedPath, `${verdicts.join("\n")}\n`);
  }

  standing.done = nextBatch;
  writeProgress(folder, progress);
  console.log(`묶음 ${nextBatch} (${judge.name}): 판정 ${verdicts.length}, ${frozen.length}행 굳음 (유해 ${harmful.size}).`);
}

// The batches go to whichever judge is free, one batch in hand a judge.
async function judgeRows(rows: readonly UnjudgedRow[], size: number): Promise<void> {
  const queue = [...judgeBatches(rows, size, answerCap)];

  await Promise.all(judges.map(async (judge) => {
    for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
      await judgeBatch(judge, batch);
    }
  }));
}

if (!wantFreezeOnly) {
  // A resume seeded the rows a past run judged, so the pass takes only what is left — on a fresh run
  // that is every candidate, on a resume only the ones still unjudged.
  const pending = uniqueRows.filter((row) => !judged.has(row.id));

  if (pending.length > 0) {
    const raised = await roads[roadName]();

    if (raised.judges.length === 0) {
      console.error(`laya-downgrade: ${roadName} 길에서 판정할 곳이 없습니다. 먼저 텍스트 모델 앞단을 세우세요 (bun scripts/n5-llm-install.ts).`);
      process.exit(1);
    }

    judges = raised.judges;
    progress.model = raised.model;
    progress.effort = raised.effort;
  }

  await judgeRows(pending, batchSize);

  for (let round = 0; round < retryRounds; round += 1) {
    const unread = uniqueRows.filter((row) => !judged.has(row.id));

    if (unread.length === 0) {
      break;
    }

    console.log(`못 읽은 ${unread.length}개를 다시 물어봅니다 (${round + 1}/${retryRounds}).`);
    await judgeRows(unread, 1);
  }
}

standing.kept = defuseRows + cleanRows;
standing.done = nextBatch;
standing.unreadable = uniqueRows.filter((row) => !judged.has(row.id)).length;
writeProgress(folder, progress);

const meta = freezeSplits(folder, progress);

// Each downgrade's outcome, read from which of its candidate rows the judge found harmful, written to
// the live file 하스 watches. Only the room, the moment and the outcome go — never the body — and the
// file is written whole for this run rather than appended to, so it reads as this run's own reckoning.
let harmfulEvents = 0;
let overRefusal = 0;
let unknown = 0;
const liveLines: string[] = [];

for (const [key, ids] of keysByEvent) {
  const event = eventOf.get(key)!;
  const outcome = eventOutcome(ids, harmful, adjacent);

  if (outcome === "harmful") {
    harmfulEvents += 1;
  } else if (outcome === "over-refusal") {
    overRefusal += 1;
  } else {
    unknown += 1;
  }

  liveLines.push(`${new Date(event.at * 1000).toISOString()} room ${event.chatId ?? "?"} ${outcome} (구간 ${ids.length})`);
}

writeFileSync(join(root, "live.txt"), `${liveLines.join("\n")}\n`);

console.log("");
console.log(`${folder} 에 ${meta.gates[0]?.rows ?? 0}행 굳었어요 (DEFUSE ${defuseRows}, CLEAN ${cleanRows}).`);
console.log(`강등 ${events.length}건: 유해 ${harmfulEvents}, 과잉 반응 ${overRefusal}, 원인 불명 ${unknown}.`);
