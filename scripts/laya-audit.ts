import { existsSync } from "node:fs";

import { auditFrozen, auditLines, freshSeed } from "../src/laya-audit";
import { gatesToRebuild, judgedNothing, verdictLines, verdictsFor } from "../src/gate-verdict";
import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { runFolder } from "../src/roots";

// What a frozen dataset is worth, per gate, and whether each gate clears the bars the
// specification fixes. A gate that does not is named for what it missed and by how much, which is
// what tells anybody rebuilding it what to expect to be different.

const usage = `usage: bun scripts/laya-audit.ts <폴더> [--gate <게이트>]… [--sample <n>] [--seed <씨앗>] [--json]

굳은 데이터 폴더를 게이트마다 재고, 수율·형식·답 비율·언어·겹침과 바닥이 기준을 넘는지 판정한다.
<폴더> 는 런타임 데이터 뿌리 아래의 이름이거나 절대 경로다.
--sample 은 게이트당 뽑을 행 수(기본 200), 0이면 전부.
--seed 를 주면 그 씨앗으로 같은 표본을 다시 뽑는다. 주지 않으면 새로 만들어 함께 적는다.
--json 은 수치와 판정을 그대로 낸다.

기준을 못 넘은 게이트가 있으면 1로 끝난다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--gate": true, "--sample": true, "--seed": true, "--json": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-audit: ${reading.trouble ?? "검사할 폴더 하나를 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const folder = runFolder(reading.loose[0]!);

if (!existsSync(folder)) {
  console.error(`laya-audit: ${folder} 가 없습니다.`);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");

for (const gate of wanted) {
  if (synthesisFor(gate) === null) {
    console.error(`laya-audit: ${gate} 은 게이트 이름이 아닙니다. 하나를 고르세요: ${gateSyntheses.map((one) => one.gate).join(", ")}`);
    process.exit(2);
  }
}

const audit = auditFrozen({
  folder,
  sample: Number(lastOf(reading, "--sample") ?? "200"),
  seed: lastOf(reading, "--seed") ?? freshSeed(),
  gates: wanted,
});

const verdicts = verdictsFor(audit);

if (asked(reading, "--json")) {
  console.log(JSON.stringify({ audit, verdicts }, null, 2));
} else {
  console.log(auditLines(audit).join("\n"));
  console.log("");
  console.log(verdictLines(verdicts).join("\n"));
}

if (judgedNothing(verdicts)) {
  console.error(`laya-audit: ${folder} 아래에서 잴 수 있는 게이트를 찾지 못했습니다.`);
  process.exit(1);
}

if (gatesToRebuild(verdicts).length > 0) {
  process.exit(1);
}
