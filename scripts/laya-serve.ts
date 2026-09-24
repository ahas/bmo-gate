import { asksUsage, lastOf, readFlags } from "../src/flags";
import { jakeConsole, spawnRunner } from "../src/jake";
import { serveCheckpoint } from "../src/laya-serve";
import { LLM_NODE } from "../src/llm-install";

// A collected checkpoint put in service on n6 (docs/llm-server.md, 「Putting a checkpoint in service」).
//
// usage: bun scripts/laya-serve.ts <학습 게이트>/<실행>/step-<n> [--gate <게이트>]

const usage = `usage: bun scripts/laya-serve.ts <학습 게이트>/<실행>/step-<n> [--gate <게이트>]

작업대 모음 자리에 가져온 체크포인트를 ${LLM_NODE} 의 Laya 엔진 곁으로 나른다. 해시를 맞춰 본 뒤에야 제 이름을 준다.
이미 ${LLM_NODE} 에 있는 체크포인트는 다시 나르지 않는다.
--gate 를 주면 그 게이트(비모가 묻는 이름)를 이 체크포인트가 맡도록 설정 파일의 그 쌍만 고치고, 엔진을 다시 띄워
health 가 그렇게 답할 때까지 기다린다. 어느 체크포인트를 쓸지는 하스가 정한다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--gate": true });

if (reading.trouble !== null || reading.loose.length !== 1) {
  console.error(`laya-serve: ${reading.trouble ?? "체크포인트 하나를 이름으로 주세요"}`);
  console.error(usage);
  process.exit(2);
}

const served = await serveCheckpoint({
  runner: spawnRunner,
  console: jakeConsole(),
  checkpoint: reading.loose[0]!,
  gate: lastOf(reading, "--gate"),
  say: (line) => console.log(line),
});

if (typeof served === "string") {
  console.error(`laya-serve: ${served}`);
  process.exit(1);
}

console.log(served.gate === null
  ? `${LLM_NODE} 에 ${reading.loose[0]} 가 있어요. 게이트에 붙이려면 --gate 를 주세요.`
  : `${served.gate} 는 이제 ${reading.loose[0]} 로 답해요.`);
