import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { dataPath } from "../src/roots";
import { passTables, TABLE_TAU, tablesJson } from "../src/train/evaluate";
import { readLedger } from "../src/train/ledger";

// The tables a pass is judged on (docs/training.md, 「The tables」), assembled from the pass's own
// ledger, which carries the calibration's report, so nothing is read twice and nothing can have moved
// in between.

const usage = `usage: bun scripts/laya-tables.ts <회차> [--tau <n>] [--json] [--out <파일>]

학습 회차의 원장에서 표를 만든다: 게이트마다 새 체크포인트를 견준 체크포인트(지금 서비스 중인 것, 없으면
학습 출발점)와 같은 시험 행에서 정확도·균형 정확도·예 재현·보정(ECE)을 전과 후로, 비대칭 게이트의 놓친
호출을 문턱마다, 노드마다 걸린 시간과 VRAM 최대치를 보인다. 리허설 회차면 모든 줄에 그렇다고 적힌다.
<회차> 는 런타임 데이터 뿌리의 laya-runs/ 아래 이름이거나 절대 경로다.
--tau 는 게이트별 표에 놓친 호출을 어느 문턱에서 보일지다(기본 ${TABLE_TAU}).
--out 없이는 회차 폴더의 tables.md 에 쓴다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--tau": true, "--out": true, "--json": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-tables: ${reading.trouble ?? "회차를 하나 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const name = reading.loose[0]!;
const folder = name.startsWith("/") ? name : dataPath("laya-runs", name);
const ledger = readLedger(folder);

if (ledger === null) {
  console.error(`laya-tables: ${folder} 에 회차 원장이 없어요.`);
  process.exit(1);
}

const tau = Number(lastOf(reading, "--tau") ?? TABLE_TAU);

if (!Number.isFinite(tau) || tau <= 0 || tau > 1) {
  console.error("laya-tables: --tau 는 0과 1 사이의 수예요.");
  process.exit(2);
}

if (asked(reading, "--json")) {
  console.log(JSON.stringify(tablesJson(ledger, tau), null, 2));
  process.exit(0);
}

const sheet = passTables(ledger, tau).join("\n");
const where = lastOf(reading, "--out") ?? join(folder, "tables.md");

writeFileSync(where, `${sheet}\n`);
console.log(sheet);
console.error(`표: ${where}`);
