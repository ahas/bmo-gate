import { asksUsage, lastOf, readFlags } from "../src/flags";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import { HEALTH_URL, installLlmService, LAYA_SERVICE_PLACEMENT, NODE_HEADER } from "../src/llm-install";
import { connectionCalls, readConnection } from "../src/node-reach";
import { placementOrExit, placementPath } from "../src/placement";

// The Laya service put on the nodes its placement names, or brought up to date there, and then the
// relay on the operations machine, which asks them in order, waited for until it answers
// (docs/llm-server.md, 「Installing and updating」). The relay's unit is the deployment's to link and
// restart, never this install's.
//
// usage: bun scripts/llm-install.ts [--node <node>]

const RELAY_UNIT = "bmo-laya-relay.service";

const usage = `usage: bun scripts/llm-install.ts [--node <node>]

Stands the Laya service (the engine, the MCP and OpenAI front, the tunnel) up on every node the placement
${placementPath(LAYA_SERVICE_PLACEMENT.file)} names, in its order, or brings it up to date there. It stands no
card arbiter: the card master stands one first when it places the service (card-master place laya --to <node>).
--node brings that one node up to date alone.
How a node is reached and which services it is reserved for are read from the node unit's node list, and
whether the machine is a WSL desktop and its card from the node itself. A node reserved for another service
is refused.
Which checkpoint answers which gate is left alone: that is bun scripts/laya-serve.ts's work.
The service key is made once on this machine and stands on a node only inside its environment file; it is
printed nowhere. What already stands is left as it is, so this may be run again as often as one likes.
At the end it waits until ${HEALTH_URL} answers through the relay (${RELAY_UNIT}), which reads the
placement again by itself; the relay's unit is the deployment's to link and restart.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--node": true });

if (reading.trouble !== null || reading.loose.length > 0) {
  console.error(`llm-install: ${reading.trouble ?? `arguments that are not options — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const placed = placementOrExit("llm-install", LAYA_SERVICE_PLACEMENT);
const only = lastOf(reading, "--node");
const nodes = only === undefined ? placed : placed.filter((one) => one.node === only);

if (nodes.length === 0) {
  console.error(`llm-install: ${only} is not a node of the placement — ${placed.map((one) => one.node).join(", ")}`);
  process.exit(2);
}

for (const at of nodes) {
  const connection = await readConnection(at.node, spawnRunner);
  if (typeof connection === "string") {
    console.error(`llm-install: ${connection}`);
    process.exit(1);
  }
  const calls = connectionCalls(connection, spawnRunner, nodeConsole());
  const outcome = await installLlmService(at, { runner: spawnRunner, console: nodeConsole(), calls, role: connection.role, say: (line) => console.log(line) });
  if (!outcome.ok) {
    console.error(`llm-install: ${at.node} stopped at ${outcome.step} — ${outcome.fault}`);
    process.exit(1);
  }
  console.log(`The Laya service of ${at.node} answers at http://${at.listen}.`);
}

for (let poll = 0; poll < 24; poll += 1) {
  try {
    const answer = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
    if (answer.status === 200) {
      console.log(`The relay answers at ${HEALTH_URL}; the node that answered is ${answer.headers.get(NODE_HEADER) ?? "(unknown)"}.`);
      process.exit(0);
    }
  } catch {
    // Asked again below.
  }
  await Bun.sleep(5_000);
}

console.error(`llm-install: ${HEALTH_URL} does not answer — see journalctl --user -u ${RELAY_UNIT}`);
process.exit(1);
