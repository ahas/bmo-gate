import { readFileSync } from "node:fs";

import { allOf, asksUsage, readFlags } from "../src/flags";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import {
  TRAINING_PLACEMENT,
  localDigests,
  nodeFileSource,
  nodeTable,
  noTrainingNodeLeft,
  notTrainingNodes,
  pinnedLaya,
  reachTrainingNodes,
  standNodes,
} from "../src/laya-nodes";
import { placementOrExit, placementPath } from "../src/placement";
import { repositoryRoot } from "../src/roots";

// The training environment on the nodes the split gates are trained on (docs/training.md,
// 「The nodes」): it reads each node, puts across what differs from this
// checkout, installs what the pinned project file names, and prints the nodes side by side.
//
// It changes nothing on a node whose card is busy, and it is run again as often as one likes: a node
// already right is read and left alone.
//
// usage: bun scripts/laya-nodes.ts [--node <name>]… [--check] [--json]

const usage = `usage: bun scripts/laya-nodes.ts [--node <name>]… [--check] [--json]

Stands the training environment up on the nodes the gates are trained on, and shows the nodes side by side.
Each node is read first; only the files that differ from this checkout are put across, and what the
project file pins is installed. A node whose card is in use is left as it stands.
Without --node, every node of the training placement ${placementPath(TRAINING_PLACEMENT.file)} is taken.
--check reads and changes nothing.
--json gives each node's outcome as JSON.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--node": true, "--check": false, "--json": false });

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-nodes: ${reading.trouble ?? `arguments that are not options — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const wanted = allOf(reading, "--node");
const training = placementOrExit("laya-nodes", TRAINING_PLACEMENT);
const nodes = wanted.length > 0 ? wanted : [...training];
const found = notTrainingNodes(nodes, training) ?? await reachTrainingNodes(nodes, spawnRunner, nodeConsole());

if (typeof found === "string") {
  console.error(`laya-nodes: ${found}`);
  process.exit(2);
}

for (const line of found.dropped) {
  console.error(`laya-nodes: ${line}`);
}

if (found.reached.size === 0) {
  console.error(`laya-nodes: ${noTrainingNodeLeft(found.dropped)}`);
  process.exit(2);
}

const reached = found.reached;

const check = argv.includes("--check");
const repository = repositoryRoot();

const outcomes = await standNodes([...reached.keys()], {
  runner: spawnRunner,
  console: nodeConsole(),
  reach: (node) => reached.get(node)!,
  repository,
  digests: localDigests(repository),
  pinned: pinnedLaya(readFileSync(nodeFileSource(repository, "pyproject.toml"), "utf8")),
  check,
  training,
  say: (line) => console.error(line),
});

if (argv.includes("--json")) {
  console.log(JSON.stringify(outcomes, null, 2));
} else {
  console.log(nodeTable(outcomes));
}

process.exit(outcomes.every((one) => one.ready) ? 0 : 1);
