import { readFileSync } from "node:fs";
import { join } from "node:path";

import { allOf, asksUsage, readFlags } from "../src/flags";
import { jakeConsole, spawnRunner } from "../src/jake";
import {
  TRAINING_NODES,
  localDigests,
  nodeTable,
  notTrainingNodes,
  pinnedLaya,
  standNodes,
} from "../src/laya-nodes";
import { sourceRoot } from "../src/roots";

// The training environment on the nodes the split gates are trained on (docs/training.md,
// 「The nodes」): it reads each node, puts across what differs from this
// checkout, installs what the pinned project file names, and prints the nodes side by side.
//
// It changes nothing on a node whose card is busy, and it is run again as often as one likes: a node
// already right is read and left alone.
//
// usage: bun scripts/laya-nodes.ts [--node <이름>]… [--check] [--json]

const usage = `usage: bun scripts/laya-nodes.ts [--node <이름>]… [--check] [--json]

게이트를 학습시킬 노드에 환경을 세우고, 노드들을 나란히 보여 준다.
노드를 먼저 살펴보고, 이 체크아웃과 다른 파일만 올리고, pyproject가 고정한 것을 깐다.
카드에 프로세스가 올라가 있는 노드는 건드리지 않고 그대로 둔다.
--node 없이는 ${TRAINING_NODES.join(", ")} ${TRAINING_NODES.length}대를 모두 본다.
--check는 보기만 하고 아무것도 바꾸지 않는다.
--json은 노드별 결과를 그대로 JSON으로 내놓는다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--node": true, "--check": false, "--json": false });

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-nodes: ${reading.trouble ?? `옵션이 아닌 인자가 있어요 — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const wanted = allOf(reading, "--node");
const nodes = wanted.length > 0 ? wanted : [...TRAINING_NODES];
const refused = notTrainingNodes(nodes);

if (refused !== null) {
  console.error(`laya-nodes: ${refused}`);
  process.exit(2);
}

const check = argv.includes("--check");
const folder = join(sourceRoot(), "laya-server");

const outcomes = await standNodes(nodes, {
  runner: spawnRunner,
  console: jakeConsole(),
  folder,
  digests: localDigests(folder),
  pinned: pinnedLaya(readFileSync(join(folder, "pyproject.toml"), "utf8")),
  check,
  say: (line) => console.error(line),
});

if (argv.includes("--json")) {
  console.log(JSON.stringify(outcomes, null, 2));
} else {
  console.log(nodeTable(outcomes));
}

process.exit(outcomes.every((one) => one.ready) ? 0 : 1);
