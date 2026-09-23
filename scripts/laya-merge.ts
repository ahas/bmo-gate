import { existsSync } from "node:fs";

import { gatesTrainingWouldRefuse, mergeGates, readsAsRehearsal } from "../src/gate-merge";
import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { datasetFolder, runFolder } from "../src/roots";

// The run's gates into the one dataset folder the training driver is handed.

const usage = `usage: bun scripts/laya-merge.ts <실행> [--gate <게이트>]… [--into <폴더>] [--overwrite]

실행 폴더 아래 게이트별로 굳은 데이터를 하나의 데이터셋 폴더로 묶는다.
<실행> 은 런타임 데이터 뿌리 아래의 이름이거나 절대 경로다.
--gate 를 주면 그 게이트만 묶는다. 주지 않으면 굳어 있는 게이트 전부.
--into 는 묶어 넣을 폴더(기본: 실행 폴더 아래 dataset).
--overwrite 는 이미 굳은 데이터셋을 덮어쓴다. 주지 않으면 아무것도 쓰지 않는다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--gate": true, "--into": true, "--overwrite": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-merge: ${reading.trouble ?? "묶을 실행 하나를 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const root = runFolder(reading.loose[0]!);

if (!existsSync(root)) {
  console.error(`laya-merge: ${root} 가 없습니다.`);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");

for (const gate of wanted) {
  if (synthesisFor(gate) === null) {
    console.error(`laya-merge: ${gate} 은 게이트 이름이 아닙니다. 하나를 고르세요: ${gateSyntheses.map((one) => one.gate).join(", ")}`);
    process.exit(2);
  }
}

const into = lastOf(reading, "--into") ?? datasetFolder(root);
const report = mergeGates({
  root,
  into,
  gates: wanted.length === 0 ? null : wanted,
  overwrite: asked(reading, "--overwrite"),
});

if (typeof report === "string") {
  console.error(`laya-merge: ${report}`);
  process.exit(2);
}

console.log(`${report.folder} 에 ${report.gates.length}게이트를 묶었습니다.`);
console.log(`학습 ${report.rows.train} · 보정 ${report.rows.calibration} · 시험 ${report.rows.test}`);
console.log(`모델 ${report.meta.model} (${report.meta.effort}), 길 ${report.meta.road}`);
console.log(`캐시읽기 ${report.meta.tokens.cacheReadTokens} 새 입력 ${report.meta.tokens.inputTokens} 출력 ${report.meta.tokens.outputTokens}`);

if (report.duplicates > 0) {
  console.log(`같은 행이 두 폴더에 있어 ${report.duplicates}줄을 한 번만 넣었습니다. 폴더가 섞여 있지 않은지 보세요.`);
}

if (readsAsRehearsal(report.folder)) {
  console.error("laya-merge: 묶은 데이터셋이 리허설로 읽힙니다. 학습 판이 진짜 데이터로 보지 않습니다.");
  process.exit(1);
}

const short = gatesTrainingWouldRefuse(report.folder, report.gates);

if (short.length > 0) {
  console.error(`laya-merge: ${short.join(", ")} 은 세 분할 가운데 비어 있는 것이 있어 학습 판이 거절합니다.`);
  process.exit(1);
}

console.log(`${report.gates.length}게이트 모두 학습 판이 잘라 쓸 수 있습니다.`);
