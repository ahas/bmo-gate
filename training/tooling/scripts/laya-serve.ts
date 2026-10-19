import { asksUsage, lastOf, readFlags } from "../src/flags";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import { releaseGate, serveCheckpoint } from "../src/laya-serve";
import { layaHealth } from "../src/laya-service";
import { rotateCollection, rotationLines, servedNow } from "../src/laya-rotate";
import { LAYA_SERVICE_PLACEMENT, SERVICE_NAME } from "../src/llm-install";
import { connectionCalls, readConnection, reservedAgainst } from "../src/node-reach";
import { placementOrExit, placementPath } from "../src/placement";

// A collected checkpoint put in service on the nodes the service's placement names, one after another,
// or a gate no longer asked taken out of their settings (docs/llm-server.md, 「Putting a checkpoint in
// service」).
//
// usage: bun scripts/laya-serve.ts <training gate>/<run>/step-<n> [--gate <gate>] [--node <node>]
//        bun scripts/laya-serve.ts --release <gate> [--node <node>]

const usage = `usage: bun scripts/laya-serve.ts <training gate>/<run>/step-<n> [--gate <gate>] [--node <node>]
       bun scripts/laya-serve.ts --release <gate> [--node <node>]

Carries a checkpoint from the workbench's collection to the Laya engine on each Laya service node, in the order of
the placement file ${placementPath(LAYA_SERVICE_PLACEMENT.file)}. --node carries it to that one node alone. It is
given its own name only once its hash matches, and a checkpoint already on a node is not carried again.
--gate makes this checkpoint answer that gate (the name the gate asks by), changing only that pair in the settings
file, starts the engine again and waits until health answers so. Which checkpoint serves is the owner's choice.
--release takes the pair of a gate no longer asked out of the settings file, starts the engine again and waits until
health no longer names that gate.
Checkpoints stay on the nodes and in the collection, and the collection is not rotated.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--gate": true, "--node": true, "--release": true });
const releasing = lastOf(reading, "--release");

if (reading.trouble !== null || reading.loose.length !== (releasing === undefined ? 1 : 0) || (releasing !== undefined && lastOf(reading, "--gate") !== undefined)) {
  console.error(`laya-serve: ${reading.trouble ?? (releasing === undefined ? "name one checkpoint" : "give --release one gate name")}`);
  console.error(usage);
  process.exit(2);
}

const placed = placementOrExit("laya-serve", LAYA_SERVICE_PLACEMENT);
const only = lastOf(reading, "--node");
const nodes = only === undefined ? placed : placed.filter((one) => one.node === only);

if (nodes.length === 0) {
  console.error(`laya-serve: ${only} is no node of the placement file: ${placed.map((one) => one.node).join(", ")}`);
  process.exit(2);
}

for (const at of nodes) {
  const connection = await readConnection(at.node, spawnRunner);
  const refused = typeof connection === "string" ? connection : reservedAgainst(SERVICE_NAME, at.node, connection);
  if (typeof connection === "string" || refused !== null) {
    console.error(`laya-serve: ${refused}`);
    process.exit(1);
  }
  const calls = connectionCalls(connection, spawnRunner, nodeConsole());
  // The node's own health, at its own listen, rather than whichever node the relay reaches.
  const health = () => layaHealth(`http://${at.listen}`);
  const say = (line: string) => console.log(line);

  if (releasing !== undefined) {
    const released = await releaseGate({ runner: spawnRunner, node: at.node, calls, console: nodeConsole(), gate: releasing, health, say });

    if (typeof released === "string") {
      console.error(`laya-serve: ${at.node}: ${released}`);
      process.exit(1);
    }

    console.log(released.released ? `${at.node}: ${releasing} no longer answers.` : `${at.node}'s settings hold no ${releasing}.`);
    continue;
  }

  const served = await serveCheckpoint({
    runner: spawnRunner,
    node: at.node,
    calls,
    console: nodeConsole(),
    checkpoint: reading.loose[0]!,
    gate: lastOf(reading, "--gate"),
    health,
    say,
  });

  if (typeof served === "string") {
    console.error(`laya-serve: ${at.node}: ${served}`);
    process.exit(1);
  }

  console.log(served.gate === null
    ? `${reading.loose[0]} stands on ${at.node}. Give --gate to put it on a gate.`
    : `${at.node}: ${served.gate} now answers with ${reading.loose[0]}.`);
}

// A gate named anew records the checkpoint as its own and rotates the collection, the one it replaced
// kept to roll back to (docs/training.md, 「Rotating the collection」).
if (lastOf(reading, "--gate") !== undefined) {
  const rotation = await rotateCollection({ served: () => servedNow(placed) });

  console.log(typeof rotation === "string" ? `checkpoint rotation: ${rotation}` : rotationLines(rotation, false).join("\n"));
}
