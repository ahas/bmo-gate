import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { asksUsage, lastOf, readFlags } from "../src/flags";
import { TABLE_TAU, runTables, tablesJson } from "../src/laya-tables";
import { readTrainLedger } from "../src/laya-train";
import { dataPath } from "../src/roots";

// The two tables the run is judged on (docs/laya-train-run.md, 「The two tables」): the per-gate one
// that decides whether a gate's trained model is put in service at all, and the per-node one that says what
// each run cost. Both are assembled from the run's own ledger, which carries the calibration's
// report, so nothing is read twice and nothing can have moved in between.
//
// usage: bun scripts/laya-tables.ts --run <이름> [--tau <n>] [--json] [--out <파일>]

const usage = `usage: bun scripts/laya-tables.ts --run <이름> [--tau <n>] [--json] [--out <파일>]

실행 원장에서 검증 표 두 개를 만든다.
게이트별 표는 기준 모델 대비 정확도, 균형 정확도, LLM과의 일치율, 보정(ECE)을, 비대칭 게이트는
놓친 호출을 따로 센 표를, 노드별 표는 VRAM 최대치와 걸린 시간과 배치와 정밀도를 보인다.
리허설 데이터로 학습한 실행이면 표의 모든 줄에 그렇다고 적힌다 — 한 줄만 떼어 읽어도 증거로
오해할 수 없게.
--tau 는 게이트별 표에 놓친 호출을 어느 문턱에서 보일지다(기본 ${TABLE_TAU}). 전체 사다리는 아래 표에 있다.
--out 없이는 실행 폴더의 tables.md 에 쓴다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--run": true, "--tau": true, "--out": true, "--json": false });

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-tables: ${reading.trouble ?? `옵션이 아닌 인자가 있어요 — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const value = (flag: string) => lastOf(reading, flag) ?? null;
const run = value("--run");

if (run === null) {
  console.error("laya-tables: 어느 실행의 표인지 --run 으로 주세요.");
  console.error(usage);
  process.exit(2);
}

const folder = run.startsWith("/") ? run : dataPath("laya-runs", run);
const ledger = readTrainLedger(folder);

if (ledger === null) {
  console.error(`laya-tables: ${folder} 에 실행 원장이 없어요. 먼저 학습을 돌리세요.`);
  process.exit(1);
}

const said = value("--tau");
const tau = said === null ? TABLE_TAU : Number(said);

if (!Number.isFinite(tau) || tau <= 0 || tau > 1) {
  console.error("laya-tables: --tau 는 0과 1 사이의 수예요.");
  process.exit(2);
}

if (argv.includes("--json")) {
  console.log(JSON.stringify(tablesJson(ledger, tau), null, 2));
  process.exit(0);
}

const sheet = runTables(ledger, tau).join("\n");
const where = value("--out") ?? join(folder, "tables.md");

writeFileSync(where, `${sheet}\n`);
console.log(sheet);
console.error(`표: ${where}`);
