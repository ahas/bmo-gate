import { readFileSync } from "node:fs";
import { join } from "node:path";

import { claimGate, releaseGate } from "../src/gate-claim";
import { allOf, asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import { collectCheckpoint, collectionRoot, readManifest } from "../src/laya-collect";
import { localDigests, nodeFileSource, noTrainingNodeLeft, notTrainingNodes, pinnedLaya, reachTrainingNodes, readCard, standNodes, TRAINING_PLACEMENT } from "../src/laya-nodes";
import { placementOrExit, placementPath } from "../src/placement";
import { carryCheckpoint } from "../src/laya-serve";
import { layaHealth, servingCheckpoint } from "../src/laya-service";
import { rotateCollection, rotationLines, servedByPlacement } from "../src/laya-rotate";
import { clearingLines, clearNode, spentVerdicts } from "../src/laya-spent";
import { dataPath, repositoryRoot } from "../src/roots";
import { curveLines, readCurve } from "../src/train/curve";
import { BESIDE_DIR, runGate } from "../src/train/gate-run";
import { runPass } from "../src/train/pass";
import { readQuiet, waitQuiet } from "../src/train/quiet";
import { sourceOf, toppedUp } from "../src/train/sources";

// One training pass over a source (docs/training.md): which gates are trained and why the rest wait,
// each chosen gate on a node of its own, calibrated beside the checkpoint serving it, its checkpoint
// carried back, and the ledger, the curve and the tables written.

const usage = `usage: bun scripts/laya-train.ts <source> [--gate <gate>]… [--node <node>]… [--rarer <n>] [--top-up <run>] [--epochs <n>] [--seed <n>] [--save-every <n>] [--kind-ratio <kind>=<n>]… [--give-way [--spare <unit>]…] [--dry-run] [--show]

Hands each of the source's gates grown enough to train to a node of its own, measures each finished checkpoint
beside the checkpoint served now on the same test rows, and leaves the ledger, the curve and the tables (docs/training.md).
<source> is reference:<run> (the reference data), judging:<run> (a judging run) or folder:<path> (a data folder, a rehearsal among them).
--gate looks at those gates alone. Without --node, every node of the training placement ${placementPath(TRAINING_PLACEMENT.file)} is used.
--rarer is how many rarer answers a judging run's gate waits for (the reference data asks 200 of its own).
--top-up adds, gate by gate, the rows of a run that wrote the rarer answer (laya-synth --top-up) to training and calibration.
  The test holds the source's rows alone, and the curve stands apart under the name <source>.<run>.
--give-way waits, before each gate is handed to a node, for this machine to quieten: no job or training running but the
  units named with --spare, and memory to spare (docs/reference-data.md, 「A round on request」).
--kind-ratio holds the questions of rows naming that kind of input to their own balance ratio (docs/laya-server.md).
--dry-run only says which gates are trained and why the rest wait, and touches nothing.
--show shows the source's curve.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--gate": true, "--node": true, "--rarer": true, "--top-up": true, "--epochs": true, "--seed": true, "--save-every": true, "--kind-ratio": true, "--give-way": false, "--spare": true, "--dry-run": false, "--show": false,
});

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-train: ${reading.trouble ?? "give one source."}`);
  console.error(usage);
  process.exit(2);
}

const named = sourceOf(reading.loose[0]!, { rarer: Number(lastOf(reading, "--rarer") ?? "0") });

if (typeof named === "string") {
  console.error(`laya-train: ${named}`);
  process.exit(2);
}

const topUp = lastOf(reading, "--top-up");
const source = topUp === undefined ? named : toppedUp(named, topUp);

const curve = dataPath("laya-curve", source.name);
const say = (line: string) => console.error(line);

if (asked(reading, "--show")) {
  const points = readCurve(curve);

  console.log(points.length === 0 ? `${curve} holds no curve yet.` : curveLines(points).join("\n"));
  process.exit(0);
}

const training = placementOrExit("laya-train", TRAINING_PLACEMENT);

// No training node at all is a placement saying so, and a pass asked of it trains nothing.
if (training.length === 0 && allOf(reading, "--node").length === 0) {
  console.log(`laya-train: ${notTrainingNodes([], training)}; this pass trains nothing.`);
  process.exit(0);
}

const askedNodes = allOf(reading, "--node").length > 0 ? allOf(reading, "--node") : [...training];
// Each node reached as the node unit's node list says, read once for the pass.
const found = notTrainingNodes(askedNodes, training) ?? await reachTrainingNodes(askedNodes, spawnRunner, nodeConsole());

if (typeof found === "string") {
  console.error(`laya-train: ${found}`);
  process.exit(2);
}

for (const line of found.dropped) {
  console.log(`laya-train: ${line}`);
}

// Every node dropping out leaves nothing to train on, which is said and is no fault of the pass.
if (found.reached.size === 0) {
  console.log(`laya-train: ${noTrainingNodeLeft(found.dropped)}; this pass trains nothing.`);
  process.exit(0);
}

const nodes = [...found.reached.keys()];
const reach = (node: string) => found.reached.get(node)!;

const dryRun = asked(reading, "--dry-run");
const giveWay = asked(reading, "--give-way") && !dryRun;

// One pass at a time per source: a pass started beside another one would put two gates on one
// card. A pass already going is doing this pass's work, so standing down is not a failure.
const refusal = dryRun ? null : claimGate(curve);

if (refusal !== null) {
  console.log(`Another pass is running, so this one stands down.\n${refusal}`);
  process.exit(0);
}

const repository = repositoryRoot();
const args: string[] = [];

for (const flag of ["--epochs", "--seed", "--save-every"]) {
  const given = lastOf(reading, flag);

  if (given !== undefined) {
    args.push(flag, given);
  }
}

for (const given of allOf(reading, "--kind-ratio")) {
  args.push("--kind-ratio", given);
}

const health = dryRun ? null : await layaHealth();
const report = await runPass({
  source,
  curve,
  passFolder: (pass) => dataPath("laya-runs", pass),
  gates: allOf(reading, "--gate").length > 0 ? allOf(reading, "--gate") : null,
  dryRun,
  hands: {
    // A node is stood up before it is given a gate, and a node whose card is busy is left out.
    nodes: async () => {
      const outcomes = await standNodes(nodes, {
        runner: spawnRunner,
        console: nodeConsole(),
        reach,
        repository,
        digests: localDigests(repository),
        pinned: pinnedLaya(readFileSync(nodeFileSource(repository, "pyproject.toml"), "utf8")),
        training,
        say,
      });

      for (const one of outcomes.filter((outcome) => !outcome.ready)) {
        say(`${one.node}: left out of this pass: ${one.fault ?? one.setup}`);
      }

      return outcomes.filter((one) => one.ready).map((one) => one.node);
    },
    // A pass that gives way waits for this machine to be quiet before every gate, apart from the card's
    // own wait, so no node is dropped from the pass for it.
    card: async (node) => {
      if (giveWay) {
        await waitQuiet({ spare: allOf(reading, "--spare"), read: readQuiet, wait: (ms) => Bun.sleep(ms), say });
      }

      return readCard(node, spawnRunner, nodeConsole(), reach(node));
    },
    // The checkpoint serving the gate today, where the collection holds it.
    beside: async (gate) => {
      const served = servingCheckpoint(health, gate)?.replace(/^checkpoints\//, "") ?? null;

      return served !== null && readManifest(join(collectionRoot(), served)) !== null ? served : null;
    },
    runGate: (gate, node, round, run) => runGate(gate, node, round, {
      runner: spawnRunner,
      console: nodeConsole(),
      reach,
      pass: run.pass,
      rehearsal: source.rehearsal,
      folder: run.folder,
      beside: run.beside,
      args,
      carryBeside: async (at, checkpoint) => {
        const carried = await carryCheckpoint({ runner: spawnRunner, console: nodeConsole(), calls: reach(at), node: at, checkpoint, dir: BESIDE_DIR, say });

        return typeof carried === "string" ? carried : null;
      },
      collect: async (ask) => {
        const carried = await collectCheckpoint({
          runner: spawnRunner, console: nodeConsole(), calls: reach(ask.node), node: ask.node, gate: ask.gate, run: run.pass, step: ask.step,
          checkpoint: ask.kind, source: ask.source, dataset: run.pass, rehearsal: source.rehearsal, training, root: collectionRoot(), say,
        });

        return typeof carried === "string" ? carried : { folder: carried.folder };
      },
      say,
    }),
  },
  say,
}).finally(() => {
  if (!dryRun) {
    releaseGate(curve);
  }
});

if (report.fault !== null) {
  console.error(`laya-train: ${report.fault}`);
  process.exit(1);
}

if (dryRun || report.ledger === null) {
  console.log(report.train.length === 0
    ? "No gate to train this pass."
    : `gates trained this pass: ${report.train.join(", ")}`);
  process.exit(0);
}

// Every gate of the pass has its line, so the collection is rotated around what is served
// (docs/training.md, 「Rotating the collection」); a rotation that cannot run leaves the pass as it was.
const rotation = await rotateCollection({ served: () => servedByPlacement() });

console.log(typeof rotation === "string" ? `checkpoint rotation: ${rotation}` : rotationLines(rotation, false).join("\n"));

// The pass's nodes cleared of the runs already carried back (docs/training.md, 「Clearing spent runs off
// the nodes」); a node that cannot say what it holds keeps everything.
const verdicts = spentVerdicts();

for (const node of report.ledger.nodes) {
  console.log(clearingLines(await clearNode({ node, calls: reach(node), verdicts }), false).join("\n"));
}
console.log(`tables written to ${dataPath("laya-runs", report.training!)}/tables.md.`);
console.log(curveLines(readCurve(curve)).join("\n"));
process.exit(report.ledger.rows.every((row) => row.state === "done") ? 0 : 1);
