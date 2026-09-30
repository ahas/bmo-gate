import { allOf, asksUsage, readFlags } from "../src/flags";
import { jakeConsole, spawnRunner } from "../src/jake";
import { TEXT_NODES, installTextModel, textHealthUrl } from "../src/n5-llm-install";

// The uncensored text model put on the training nodes, or brought up to date there (docs/n5-llm.md,
// 「Installing and updating」). It is the one way the service is installed, and it is run again to
// update. With no --node it stands the model on every node in ${TEXT_NODES}; name --node to do one.
//
// usage: bun scripts/n5-llm-install.ts [--node <이름>]…

const usage = `usage: bun scripts/n5-llm-install.ts [--node <이름>]…

텍스트 모델 서비스(OpenAI 호환 앞단, llama.cpp, 모델 파일, 터널)를 노드에 세우거나 새로 맞춘다.
--node 없이는 ${TEXT_NODES.join(", ")} 를 모두 세운다. --node 로 한 대만 할 수도 있다.
서비스 키는 main-host 에 노드마다 하나씩 만들고, 노드에는 설정 파일 안에만 둔다. 키는 어디에도 찍지 않는다.
memlock 한도는 노드마다 손으로 한 번 16G 로 올려 둬야 한다 (docs/n5-llm.md 「The memlock limit」).
이미 서 있는 것은 그대로 두니 몇 번이든 다시 돌려도 된다.
끝나면 노드마다 health 가 답할 때까지 기다린다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--node": true });

if (!reading.ok || reading.loose.length > 0) {
  console.error(`n5-llm-install: ${reading.trouble ?? `옵션이 아닌 인자가 있어요 — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const wanted = allOf(reading, "--node");
const bad = wanted.find((node) => !(TEXT_NODES as readonly string[]).includes(node));

if (bad !== undefined) {
  console.error(`n5-llm-install: ${bad} 는 텍스트 모델 노드가 아니에요 (${TEXT_NODES.join(", ")}).`);
  process.exit(2);
}

const nodes = wanted.length > 0 ? wanted : [...TEXT_NODES];
const console_ = jakeConsole();
let failed = false;

for (const node of nodes) {
  console.log(`\n=== ${node} ===`);

  const outcome = await installTextModel(node, { runner: spawnRunner, console: console_, say: (line) => console.log(line) });

  if (outcome.ok) {
    console.log(`${node} 의 텍스트 모델이 ${textHealthUrl(node)} 에서 답해요.`);
  } else {
    failed = true;
    console.error(`${node}: ${outcome.step} 에서 멈췄어요 — ${outcome.fault}`);
  }
}

process.exit(failed ? 1 : 0);
