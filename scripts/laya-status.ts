import { existsSync } from "node:fs";

import { readRunStanding, standingLines } from "../src/gate-run";
import { asksUsage, allOf, asked, readFlags } from "../src/flags";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { runFolder } from "../src/roots";

import type { GateSynthesis } from "../src/laya-synth";

// How far a run got, read straight off its folders. It asks the run nothing and holds nothing up:
// a gate writes its progress after every batch, so the folder is the account of it whether the
// run is still going, finished, or was killed an hour ago.

const usage = `usage: bun scripts/laya-status.ts <실행> [--gate <게이트>]… [--json]

실행 폴더를 열어 게이트마다 묶음이 몇 개나 굳었는지, 행이 몇 줄인지, 날린 묶음과 버린 행이 얼마인지 낸다.
<실행> 은 런타임 데이터 뿌리 아래의 이름이거나 절대 경로다.
--gate 를 주면 그 게이트만 본다. 주지 않으면 열 개 전부.
--json 은 수치를 그대로 낸다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--gate": true, "--json": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-status: ${reading.trouble ?? "볼 실행 하나를 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const root = runFolder(reading.loose[0]!);

if (!existsSync(root)) {
  console.error(`laya-status: ${root} 가 없습니다.`);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");
const gates: GateSynthesis[] = wanted.length === 0
  ? [...gateSyntheses]
  : wanted.map((name) => {
      const spec = synthesisFor(name);

      if (spec === null) {
        console.error(`laya-status: ${name} 은 게이트 이름이 아닙니다. 하나를 고르세요: ${gateSyntheses.map((one) => one.gate).join(", ")}`);
        process.exit(2);
      }

      return spec;
    });

const standing = readRunStanding(root, gates);

if (asked(reading, "--json")) {
  console.log(JSON.stringify(standing, null, 2));
} else {
  console.log(root);
  console.log(standingLines(standing).join("\n"));
}
