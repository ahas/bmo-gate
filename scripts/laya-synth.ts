import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { claudeAccount, claudeAsker, claudeConfigDir, claudeEffort, claudeModel, claudeTimeoutMs } from "../src/claude-road";
import { codexAsker, codexEffort, codexModel, codexTimeoutMs, emptyCwd } from "../src/codex-road";
import { j3090Asker, j3090Effort, j3090Model, j3090TimeoutMs } from "../src/j3090-road";
import { n5Asker, n5Effort, n5Model, n5TimeoutMs } from "../src/n5-road";
import { driveGates } from "../src/gate-run";
import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { answersOf, gatesChosen } from "../src/laya-synth";
import { refuseInsideCheckout, runFolder } from "../src/roots";

import type { SynthAsker, SynthRoad } from "../src/laya-synth-run";

// The ten gates' distilled data, written on the codex account (docs/gate-data.md). One gate to a
// thread, all of them at once, every one frozen a batch at a time into a folder of its own.
//
// The run is meant to be left going. It is hours at the full row count, so it writes its own log
// beside the data and a gate's progress lands after every batch: `laya-status.ts` reads how far it
// got without attaching to anything.

// The specification's own figures. Neither is this command's to choose.
const defaultRows = 7_500;
const defaultBatch = 20;

const usage = `usage: bun scripts/laya-synth.ts --run <이름> [--gate <게이트>]… [--except <게이트>]…
                                 [--rows <n>] [--batch <n>]
                                 [--road codex|j3090|claude|n5] [--top-up <답>] [--at-once <n>]
                                 [--model <모델>] [--effort <노력>] [--timeout <초>] [--resume] [--overwrite]

게이트마다 실 하나를 붙들고 증류 데이터를 지어 <이름> 실행 폴더 아래에 굳힌다.
--run 은 런타임 데이터 뿌리 아래의 이름이거나 절대 경로다. 체크아웃 안에는 쓰지 않는다.
--gate 는 지을 게이트를 고른다(여러 번). 주지 않으면 열 개 전부.
--except 는 빼고 지을 게이트다(여러 번). 다른 실행이 제 길로 짓고 있는 게이트를 빼는 데 쓴다.
--rows 는 게이트당 지을 행 수(기본 ${defaultRows}), --batch 는 한 번에 받을 행 수(기본 ${defaultBatch}).
--road 는 codex(기본, 실을 붙들어 캐시를 쓴다) 또는 j3090(집의 qwen, 세션도 캐시도 없다).
  codex 가 계정 차원에서 거부하는 게이트를 codex 아닌 길로 이어 지을 때 j3090 을 쓴다.
  claude 는 2번 Claude 계정(~/.claude)에 못박힌 길로, codex 가 막힌 동안 쓴다. 세션도 캐시도 없다.
  n5 는 main-host 의 OpenAI 호환 앞단(127.0.0.1:18020/v1)에 붙은 집의 텍스트 모델이다. 세션도
  캐시도 없고, 카드가 바쁘면 503 을 잠깐 기다렸다 다시 묻는다.
  무해화 게이트는 이 드라이버가 짓지 않는다. scripts/laya-sanitize.ts 로 짓는다.
--top-up 은 모든 묶음을 이 답 하나로만 짓고 시험 쪽에는 한 행도 두지 않는다. 실제 판정 회차에
  모자란 드문 답을 학습·보정 쪽에 보태는 실행이다(docs/gate-data.md 「Invented data」).
--at-once 는 동시에 쓸 게이트 수(기본: 고른 게이트 전부).
--resume 은 쓰다 만 실행을 그다음 묶음부터 이어 간다. 이미 굳은 게이트는 그대로 둔다.
  다른 길로 이어 지어도 굳은 묶음은 그대로 두고 그다음부터 새 길로 짓는다.
--overwrite 는 게이트 폴더를 지우고 처음부터 다시 쓴다.
둘 다 없으면 비어 있지 않은 폴더에는 아무것도 쓰지 않는다.

백그라운드로 띄우려면:
  setsid bun scripts/laya-synth.ts --run <이름> </dev/null >/dev/null 2>&1 &`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--run": true, "--gate": true, "--except": true, "--rows": true, "--batch": true, "--road": true, "--top-up": true, "--at-once": true,
  "--model": true, "--effort": true, "--timeout": true, "--resume": false, "--overwrite": false,
});

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-synth: ${reading.trouble ?? `${reading.loose.join(" ")} 는 무엇인지 모르겠습니다.`}`);
  console.error(usage);
  process.exit(2);
}

const named = lastOf(reading, "--run");

if (named === undefined) {
  console.error("laya-synth: 실행 이름을 --run 으로 주세요.");
  process.exit(2);
}

const root = runFolder(named);
const inside = refuseInsideCheckout(root);

if (inside !== null) {
  console.error(`laya-synth: ${inside}`);
  process.exit(2);
}

const chosen = gatesChosen(allOf(reading, "--gate"), allOf(reading, "--except"));

if (typeof chosen === "string") {
  console.error(`laya-synth: ${chosen}`);
  process.exit(2);
}

const gates = chosen;

const road = (lastOf(reading, "--road") ?? "codex") as SynthRoad;

if (road !== "codex" && road !== "j3090" && road !== "claude" && road !== "n5") {
  console.error("laya-synth: --road 는 codex, j3090, claude, n5 가운데 하나입니다.");
  process.exit(2);
}

const topUp = lastOf(reading, "--top-up") ?? null;
const unanswerable = topUp === null ? [] : gates.filter((gate) => !answersOf(gate.questions[0]!).includes(topUp));

if (unanswerable.length > 0) {
  console.error(`laya-synth: ${unanswerable.map((gate) => gate.gate).join(", ")} 에는 ${topUp} 라는 답이 없습니다.`);
  process.exit(2);
}

// Each road brings its own model, its own effort and its own wait, and the asker that speaks it.
const roadDefaults = road === "j3090"
  ? { model: j3090Model, effort: j3090Effort, timeoutSeconds: j3090TimeoutMs / 1000 }
  : road === "n5"
    ? { model: n5Model, effort: n5Effort, timeoutSeconds: n5TimeoutMs / 1000 }
    : road === "claude"
      ? { model: claudeModel, effort: claudeEffort, timeoutSeconds: claudeTimeoutMs / 1000 }
      : { model: codexModel, effort: codexEffort, timeoutSeconds: codexTimeoutMs / 1000 };

const rows = Number(lastOf(reading, "--rows") ?? String(defaultRows));
const batchSize = Number(lastOf(reading, "--batch") ?? String(defaultBatch));
const atOnce = Number(lastOf(reading, "--at-once") ?? String(gates.length));
const model = lastOf(reading, "--model") ?? roadDefaults.model;
const effort = lastOf(reading, "--effort") ?? roadDefaults.effort;
const timeoutMs = Number(lastOf(reading, "--timeout") ?? String(roadDefaults.timeoutSeconds)) * 1000;

for (const [what, value] of [["--rows", rows], ["--batch", batchSize], ["--at-once", atOnce], ["--timeout", timeoutMs]] as const) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`laya-synth: ${what} 는 0보다 큰 수여야 합니다.`);
    process.exit(2);
  }
}

mkdirSync(root, { recursive: true });

// The run's own log, beside the data it makes, so a run left going is readable afterwards however
// it was started and whatever became of the terminal that started it.
const logPath = join(root, "run.log");

function say(line: string): void {
  console.log(line);
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

const started = Date.now();

// The asker for the chosen road. Codex and claude work in a directory holding nothing so no
// checkout's AGENTS.md is carried into a batch; J3090 is one request over HTTPS and has no such
// directory.
const asker: SynthAsker = road === "j3090"
  ? j3090Asker({ model, timeoutMs })
  : road === "n5"
    ? n5Asker({ model, timeoutMs })
    : road === "claude"
      ? claudeAsker({ model, effort, timeoutMs })
      : codexAsker({ model, effort, timeoutMs });

say(`${root}: ${gates.length}게이트, 게이트당 ${rows}행, 한 묶음 ${batchSize}행, 동시에 ${Math.min(atOnce, gates.length)}개.`);
say(road === "j3090"
  ? `모델 ${model} (${effort}), 길 j3090.`
  : road === "n5"
    ? `모델 ${model} (${effort}), 길 n5 — main-host 127.0.0.1:18020/v1.`
    : road === "claude"
      ? `모델 ${model} (${effort}), 길 claude — ${claudeConfigDir()} 의 ${claudeAccount} 에 못박힘. 작업 폴더 ${emptyCwd()}.`
      : `모델 ${model} (${effort}), 길 codex. 작업 폴더 ${emptyCwd()}.`);

if (topUp !== null) {
  say(`드문 답 보태기: 모든 묶음을 ${topUp} 로 짓고, 시험 쪽에는 두지 않습니다.`);
}

const outcomes = await driveGates({
  root,
  gates,
  rows,
  batchSize,
  model,
  effort,
  road,
  // A top-up's rows are held out of the test, which is the real rows' alone.
  shares: { calibration: 0.15, test: topUp === null ? 0.15 : 0 },
  topUp,
  atOnce,
  resume: asked(reading, "--resume"),
  overwrite: asked(reading, "--overwrite"),
  say,
}, asker);

say("");
say(`${Math.round((Date.now() - started) / 1000)}초 걸렸습니다.`);

for (const one of outcomes) {
  const figures = one.meta?.gates[0];

  say(
    figures === undefined
      ? `${one.gate}: ${one.state}${one.refusal ?? one.fault ? ` — ${(one.refusal ?? one.fault)!.split("\n")[0]}` : ""}`
      : `${one.gate}: ${figures.rows}행 (학습 ${figures.splits.train} · 보정 ${figures.splits.calibration} · 시험 ${figures.splits.test})`
        + ` · 캐시읽기 ${figures.tokens.cacheReadTokens} 새 입력 ${figures.tokens.inputTokens}`,
  );
}

const stuck = outcomes.filter((one) => one.state === "failed" || one.state === "refused");

if (stuck.length > 0) {
  say(`${stuck.map((one) => one.gate).join(", ")} 은 끝나지 않았습니다. --resume 으로 이어 가세요.`);
  process.exit(1);
}
