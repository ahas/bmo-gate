import { asksUsage, readFlags } from "../src/flags";
import { jakeConsole, spawnRunner } from "../src/jake";
import { installN5Llm, N5_HEALTH_URL, N5_NODE } from "../src/n5-llm-install";

// The text model put on n5, or brought up to date there (docs/n5-llm.md, 「Installing and updating」).
// It is the one way the service is installed, and it is run again to update.
//
// usage: bun scripts/n5-llm-install.ts

const usage = `usage: bun scripts/n5-llm-install.ts

${N5_NODE} 에 텍스트 모델 서비스(OpenAI 호환 앞단, llama.cpp, 모델 파일, 터널)를 세우거나 새로 맞춘다.
서비스 키는 main-host 에 한 번 만들고, ${N5_NODE} 에는 설정 파일 안에만 둔다. 키는 어디에도 찍지 않는다.
memlock 한도는 손으로 한 번 올려 둬야 한다 (docs/n5-llm.md 「The memlock limit」).
이미 서 있는 것은 그대로 두니 몇 번이든 다시 돌려도 된다.
끝나면 ${N5_HEALTH_URL} 가 답할 때까지 기다린다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {});

if (reading.trouble !== null || reading.loose.length > 0) {
  console.error(`n5-llm-install: ${reading.trouble ?? `옵션이 아닌 인자가 있어요 — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const outcome = await installN5Llm({ runner: spawnRunner, console: jakeConsole(), say: (line) => console.log(line) });

if (!outcome.ok) {
  console.error(`n5-llm-install: ${outcome.step} 에서 멈췄어요 — ${outcome.fault}`);
  process.exit(1);
}

console.log(`${N5_NODE} 의 텍스트 모델이 ${N5_HEALTH_URL} 에서 답해요.`);
