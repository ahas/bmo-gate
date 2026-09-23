import { asksUsage } from "../src/flags";
import { BRIDGE_PORT, SSH_TARGET, startBridge } from "../src/llm-bridge";
import { serviceKeyPath } from "../src/llm-install";

// The house LLM service's tunnel door on main-host, run by bmo-llm-bridge.service
// (docs/llm-server.md, 「The door」).
//
// usage: bun scripts/llm-bridge.ts

const usage = `usage: bun scripts/llm-bridge.ts

n6 의 터널이 HTTPS 안에 실어 보내는 SSH 를 받아 main-host 의 SSH(${SSH_TARGET.hostname}:${SSH_TARGET.port})로 잇는다.
포트 ${BRIDGE_PORT} 에서 듣고, 베어러가 서비스 키일 때만 받는다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

if (argv.length > 0) {
  console.error(`llm-bridge: 옵션이 아닌 인자가 있어요 — ${argv.join(" ")}`);
  console.error(usage);
  process.exit(2);
}

const server = startBridge({ keyPath: serviceKeyPath() });
console.log(`llm-bridge: ${server.hostname}:${server.port} 에서 듣는 중`);
