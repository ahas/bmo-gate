import { asked, asksUsage, readFlags } from "../src/flags";
import { collectionRoot } from "../src/laya-collect";
import { ROTATION_FILE, rotateCollection, rotationLines, servedByPlacement, SERVED_FILE } from "../src/laya-rotate";

// The collection rotated by hand (docs/training.md, 「Rotating the collection」). A pass that trained a
// gate and a checkpoint named for a gate rotate it on their own; this is the same rotation, and the
// dry run that says what it would do.

const usage = `usage: bun scripts/laya-rotate.ts [--dry-run]

Rotates the workbench's Laya checkpoint collection (${collectionRoot()}) around what is served.
For each training gate it keeps the checkpoint the service nodes' health says is served, each gate's checkpoint
deployed just before (the deployment record ${SERVED_FILE}), the checkpoints of a pass still running, and the
deployment candidates finished after the one served, and removes the rest.
${ROTATION_FILE} sets how many are kept (deployed 2, candidates 1 where it is absent). Where any service node does not
answer, nothing is removed.
--dry-run only says what is kept and why, and what would be removed.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--dry-run": false });

if (!reading.ok || reading.loose.length !== 0) {
  console.error(`laya-rotate: ${reading.trouble ?? "it takes no words."}`);
  console.error(usage);
  process.exit(2);
}

const dryRun = asked(reading, "--dry-run");
const rotation = await rotateCollection({ served: servedByPlacement, dryRun });

if (typeof rotation === "string") {
  console.error(`laya-rotate: ${rotation}`);
  process.exit(1);
}

console.log(rotationLines(rotation, dryRun).join("\n"));
