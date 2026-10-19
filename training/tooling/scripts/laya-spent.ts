import { allOf, asked, asksUsage, readFlags } from "../src/flags";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import { reachTrainingNodes, TRAINING_PLACEMENT } from "../src/laya-nodes";
import { clearingLines, clearNode, ledgerNodes, readLedgers, runVerdicts, sourceClaimed } from "../src/laya-spent";
import { placementOrExit, placementPath } from "../src/placement";

// The runs already carried back cleared off the nodes by hand (docs/training.md, 「Clearing spent runs off
// the nodes」). A pass that trained a gate clears its own nodes on its own; this is the same clearing,
// over any node a run has gone to, and the dry run that says what it would do.

const usage = `usage: bun scripts/laya-spent.ts [--node <node>]… [--dry-run]

Removes, from under ~/bmo-laya on the training nodes, the checkpoints/<run> and data/<run> folders of the runs whose
collection is confirmed. The pass ledger confirms it (the gate's training finished, its final checkpoint was
collected, and no collection failed), and nothing is removed while a pass trains on that pass's source. A serving
node's checkpoints/<gate>/<run>/step layout, beside/ and its logs are never touched.
Without --node, the nodes of the training placement ${placementPath(TRAINING_PLACEMENT.file)} are read. --node takes only
a node the training placement or a pass ledger names.
Where a node does not answer, or its answer cannot all be read, nothing is removed on it.
--dry-run only says what is kept and why, and what would be removed.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--node": true, "--dry-run": false });

if (!reading.ok || reading.loose.length !== 0) {
  console.error(`laya-spent: ${reading.trouble ?? "it takes no words."}`);
  console.error(usage);
  process.exit(2);
}

const training = placementOrExit("laya-spent", TRAINING_PLACEMENT);
const ledgers = readLedgers();
const named = allOf(reading, "--node");
const nodes = named.length > 0 ? named : [...training];
const known = new Set([...training, ...ledgerNodes(ledgers)]);
const strangers = nodes.filter((node) => !known.has(node));

if (strangers.length > 0) {
  console.error(`laya-spent: ${strangers.join(", ")}: neither the training placement nor a pass ledger names this node`);
  process.exit(2);
}

if (nodes.length === 0) {
  console.log(`laya-spent: the training placement ${placementPath(TRAINING_PLACEMENT.file)} places no training node; name one with --node.`);
  process.exit(0);
}

const found = await reachTrainingNodes(nodes, spawnRunner, nodeConsole());

if (typeof found === "string") {
  console.error(`laya-spent: ${found}`);
  process.exit(2);
}

for (const line of found.dropped) {
  console.log(`laya-spent: ${line}`);
}

const dryRun = asked(reading, "--dry-run");
const verdicts = runVerdicts(ledgers, (source) => sourceClaimed(source));
let faults = 0;

for (const [node, calls] of found.reached) {
  const cleared = await clearNode({ node, calls, verdicts, dryRun });

  faults += cleared.fault === null ? 0 : 1;
  console.log(clearingLines(cleared, dryRun).join("\n"));
}

process.exit(faults === 0 ? 0 : 1);
