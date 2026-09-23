import { existsSync } from "node:fs";

import { ledgerLines, readLedger } from "../src/gate-ledger";
import { asksUsage, allOf, asked, readFlags } from "../src/flags";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { runFolder } from "../src/roots";

import type { GateSynthesis } from "../src/laya-synth";

// What a run made and what it cost, gate by gate.

const usage = `usage: bun scripts/laya-ledger.ts <실행> [--gate <게이트>]… [--json]

실행 폴더를 열어 게이트마다 몇 행을 지었고 얼마를 썼는지 원장으로 낸다.
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
  console.error(`laya-ledger: ${reading.trouble ?? "볼 실행 하나를 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const root = runFolder(reading.loose[0]!);

if (!existsSync(root)) {
  console.error(`laya-ledger: ${root} 가 없습니다.`);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");
const gates: GateSynthesis[] = wanted.length === 0
  ? [...gateSyntheses]
  : wanted.map((name) => {
      const spec = synthesisFor(name);

      if (spec === null) {
        console.error(`laya-ledger: ${name} 은 게이트 이름이 아닙니다. 하나를 고르세요: ${gateSyntheses.map((one) => one.gate).join(", ")}`);
        process.exit(2);
      }

      return spec;
    });

const ledger = readLedger(root, gates);

if (typeof ledger === "string") {
  console.error(`laya-ledger: ${ledger}`);
  process.exit(2);
}

console.log(asked(reading, "--json") ? JSON.stringify(ledger, null, 2) : ledgerLines(ledger).join("\n"));
