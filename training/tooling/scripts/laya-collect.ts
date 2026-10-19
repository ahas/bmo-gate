import { asksUsage, lastOf, readFlags } from "../src/flags";
import {
  collectCheckpoint,
  collectLines,
  collectedCheckpoints,
  collectionRoot,
  type CheckpointKind,
} from "../src/laya-collect";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import { noTrainingNodeLeft, notTrainingNodes, reachTrainingNodes, TRAINING_PLACEMENT } from "../src/laya-nodes";
import { placementOrExit } from "../src/placement";
import { dataPath } from "../src/roots";
import { checkpointOnNode, stepFolder } from "../src/train/gate-run";
import { readLedger } from "../src/train/ledger";

// A checkpoint carried off the node that made it (docs/training.md, 「Checkpoint naming and
// collection」). Node-local is not enough: a node that dies must not be the only copy of a step.
//
// usage: bun scripts/laya-collect.ts --node <node> --gate <gate> --run <name> --step <n> [--kind final|step] [--overwrite]
//        bun scripts/laya-collect.ts --list

const usage = `usage: bun scripts/laya-collect.ts --node <node> --gate <gate> --run <name> --step <n> [--kind final|step] [--source <path on the node>] [--overwrite]
       bun scripts/laya-collect.ts --list

Brings a checkpoint made on a node into the collection on the workbench. The gate and the step stay readable from
its name, and where it came from and whether it is a rehearsal are written in the manifest beside it.
The same step of the same gate already standing is refused, never written over; give --overwrite to replace it.
--kind is whether it is a finished checkpoint (final) or a step on the way (step). final by default.
Without --source, the place on the node is worked out from --run and --gate.
--list shows what has been collected so far.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--node": true, "--gate": true, "--run": true, "--step": true, "--kind": true, "--source": true, "--dataset": true,
  "--overwrite": false, "--list": false, "--json": false,
});

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-collect: ${reading.trouble ?? `words that are no option: ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const value = (flag: string) => lastOf(reading, flag) ?? null;
const root = collectionRoot();

if (argv.includes("--list")) {
  const standing = collectedCheckpoints(root);

  console.log(argv.includes("--json") ? JSON.stringify(standing, null, 2) : collectLines(standing).join("\n"));
  process.exit(0);
}

const node = value("--node");
const gate = value("--gate");
const run = value("--run");
const step = Number(value("--step"));

if (node === null || gate === null || run === null || !Number.isInteger(step) || step < 0) {
  console.error("laya-collect: give all of --node, --gate, --run and --step.");
  console.error(usage);
  process.exit(2);
}

const training = placementOrExit("laya-collect", TRAINING_PLACEMENT);
const found = notTrainingNodes([node], training) ?? await reachTrainingNodes([node], spawnRunner, nodeConsole());

if (typeof found === "string" || found.reached.size === 0) {
  console.error(`laya-collect: ${typeof found === "string" ? found : noTrainingNodeLeft(found.dropped)}`);
  process.exit(2);
}

const reached = found.reached;

const kind = (value("--kind") ?? "final") as CheckpointKind;

if (kind !== "final" && kind !== "step") {
  console.error("laya-collect: --kind is final or step.");
  process.exit(2);
}

// The ledger of the run says whether it was a rehearsal; without one the caller says so itself.
const ledger = readLedger(dataPath("laya-runs", run));
const row = ledger?.rows.find((one) => one.gate === gate);
const source = value("--source")
  ?? (kind === "final" ? checkpointOnNode(run, gate) : `${checkpointOnNode(run, gate)}/steps/${stepFolder(step)}`);

const collected = await collectCheckpoint({
  runner: spawnRunner,
  console: nodeConsole(),
  calls: reached.get(node),
  node,
  gate,
  run,
  step,
  checkpoint: kind,
  source,
  dataset: value("--dataset") ?? row?.pass ?? run,
  rehearsal: row?.rehearsal ?? ledger?.rehearsal ?? false,
  training,
  overwrite: argv.includes("--overwrite"),
  root,
  say: (line) => console.error(line),
});

if (typeof collected === "string") {
  console.error(`laya-collect: ${collected}`);
  process.exit(1);
}

console.log(collectLines([collected.manifest]).join("\n"));
console.log(collected.folder);
