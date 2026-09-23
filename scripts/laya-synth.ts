import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { codexAsker, codexEffort, codexModel, codexTimeoutMs, emptyCwd } from "../src/codex-road";
import { driveGates } from "../src/gate-run";
import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { refuseInsideCheckout, runFolder } from "../src/roots";

import type { GateSynthesis } from "../src/laya-synth";

// The ten gates' distilled data, written on the codex account (docs/gate-data.md). One gate to a
// thread, all of them at once, every one frozen a batch at a time into a folder of its own.
//
// The run is meant to be left going. It is hours at the full row count, so it writes its own log
// beside the data and a gate's progress lands after every batch: `laya-status.ts` reads how far it
// got without attaching to anything.

// The specification's own figures. Neither is this command's to choose.
const defaultRows = 7_500;
const defaultBatch = 20;

const usage = `usage: bun scripts/laya-synth.ts --run <이름> [--gate <게이트>]… [--rows <n>] [--batch <n>]
                                 [--at-once <n>] [--model <모델>] [--effort <노력>]
                                 [--timeout <초>] [--resume] [--overwrite]

게이트마다 codex 실 하나를 붙들고 증류 데이터를 지어 <이름> 실행 폴더 아래에 굳힌다.
--run 은 런타임 데이터 뿌리 아래의 이름이거나 절대 경로다. 체크아웃 안에는 쓰지 않는다.
--gate 는 지을 게이트를 고른다(여러 번). 주지 않으면 열 개 전부.
--rows 는 게이트당 지을 행 수(기본 ${defaultRows}), --batch 는 한 번에 받을 행 수(기본 ${defaultBatch}).
--at-once 는 동시에 쓸 게이트 수(기본: 고른 게이트 전부).
--resume 은 쓰다 만 실행을 그다음 묶음부터 이어 간다. 이미 굳은 게이트는 그대로 둔다.
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
  "--run": true, "--gate": true, "--rows": true, "--batch": true, "--at-once": true,
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

const wanted = allOf(reading, "--gate");
const gates: GateSynthesis[] = wanted.length === 0
  ? [...gateSyntheses]
  : wanted.map((name) => {
      const spec = synthesisFor(name);

      if (spec === null) {
        console.error(`laya-synth: ${name} 은 게이트 이름이 아닙니다. 하나를 고르세요: ${gateSyntheses.map((one) => one.gate).join(", ")}`);
        process.exit(2);
      }

      return spec;
    });

const rows = Number(lastOf(reading, "--rows") ?? String(defaultRows));
const batchSize = Number(lastOf(reading, "--batch") ?? String(defaultBatch));
const atOnce = Number(lastOf(reading, "--at-once") ?? String(gates.length));
const model = lastOf(reading, "--model") ?? codexModel;
const effort = lastOf(reading, "--effort") ?? codexEffort;
const timeoutMs = Number(lastOf(reading, "--timeout") ?? String(codexTimeoutMs / 1000)) * 1000;

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

say(`${root}: ${gates.length}게이트, 게이트당 ${rows}행, 한 묶음 ${batchSize}행, 동시에 ${Math.min(atOnce, gates.length)}개.`);
say(`모델 ${model} (${effort}), 길 codex. 작업 폴더 ${emptyCwd()}.`);

const outcomes = await driveGates({
  root,
  gates,
  rows,
  batchSize,
  model,
  effort,
  shares: { calibration: 0.15, test: 0.15 },
  atOnce,
  resume: asked(reading, "--resume"),
  overwrite: asked(reading, "--overwrite"),
  say,
}, codexAsker({ model, effort, timeoutMs }));

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
