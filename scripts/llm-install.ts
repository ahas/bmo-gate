import { asksUsage, readFlags } from "../src/flags";
import { jakeConsole, spawnRunner } from "../src/jake";
import { HEALTH_URL, installLlmService, LLM_NODE } from "../src/llm-install";

// The Laya service put on n6, or brought up to date there (docs/llm-server.md, 「Installing and
// updating」). It is the one way the service is installed, and it is run again to update.
//
// usage: bun scripts/llm-install.ts

const usage = `usage: bun scripts/llm-install.ts

${LLM_NODE} 에 Laya 서비스(엔진, MCP·OpenAI 앞단, 터널)를 세우거나 새로 맞춘다.
어느 게이트를 어느 체크포인트가 맡는지는 건드리지 않는다 — 그건 bun scripts/laya-serve.ts 의 일이다.
서비스 키는 main-host 에 한 번 만들고, ${LLM_NODE} 에는 환경 파일 안에만 둔다. 키는 어디에도 찍지 않는다.
이미 서 있는 것은 그대로 두니 몇 번이든 다시 돌려도 된다.
끝나면 ${HEALTH_URL} 가 답할 때까지 기다린다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {});

if (reading.trouble !== null || reading.loose.length > 0) {
  console.error(`llm-install: ${reading.trouble ?? `옵션이 아닌 인자가 있어요 — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const outcome = await installLlmService({ runner: spawnRunner, console: jakeConsole(), say: (line) => console.log(line) });

if (!outcome.ok) {
  console.error(`llm-install: ${outcome.step} 에서 멈췄어요 — ${outcome.fault}`);
  process.exit(1);
}

console.log(`${LLM_NODE} 의 Laya 서비스가 ${HEALTH_URL} 에서 답해요.`);
