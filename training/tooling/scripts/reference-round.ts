import { allOf, asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import { nothingToTrainOn, TRAINING_PLACEMENT } from "../src/laya-nodes";
import { placementOrExit } from "../src/placement";
import { appendRound, gateSeconds, roundFolder, roundMemoryBytes, roundUnit, roundUnitLine } from "../src/reference/round";
import { dataPath, unitRoot } from "../src/roots";
import { nextPass, passName, readCurve } from "../src/train/curve";
import { readQuiet, waitQuiet } from "../src/train/quiet";
import { referenceSource } from "../src/train/sources";

import type { StepRecord } from "../src/reference/round";

// A round of the reference gates' data, run only when the owner asks (docs/reference-data.md
// 「A round on request」): started as a transient unit of its own, it waits for this machine to be
// quiet, makes a pass of the data, then a training pass over it that gives way to other work, and
// leaves a line saying how long each took.

const usage = `usage: bun scripts/reference-round.ts [<run>] [--spare <unit>]…

Starts one round of the reference gates' data as the transient unit ${roundUnit} and comes straight back
(docs/reference-data.md, 「A round on request」). The unit waits until this machine runs no other job or training
and has memory to spare, then runs the data assembly (reference-data.ts) and the training (laya-train.ts --give-way)
in turn, and writes the time each took to rounds.jsonl in the run folder.
<run> is ref-1 by default.
--spare is a job or training unit not to wait for. A job that starts a round and watches it to the end gives its own unit.
Its log is read with journalctl --user -u ${roundUnit}.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--spare": true, "--in-unit": false, "--asked": true });

if (!reading.ok || reading.loose.length > 1) {
  console.error(`reference-round: ${reading.trouble ?? "give one run name at most."}`);
  console.error(usage);
  process.exit(2);
}

const run = reading.loose[0] ?? "ref-1";
const spare = allOf(reading, "--spare");
const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` };

if (!asked(reading, "--in-unit")) {
  const active = Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", `${roundUnit}.service`], { stdin: "ignore", env });

  if (active.exitCode === 0) {
    console.error(`reference-round: a round is still running; see journalctl --user -u ${roundUnit}.`);
    process.exit(1);
  }

  // A round asked for with nowhere to train is refused before its data pass, and says why.
  const nowhere = await nothingToTrainOn(placementOrExit("reference-round", TRAINING_PLACEMENT), spawnRunner, nodeConsole());

  if (nowhere !== null) {
    console.error(`reference-round: ${nowhere}; no round is started.`);
    process.exit(1);
  }

  const started = Bun.spawnSync(roundUnitLine({ run, spare, asked: new Date().toISOString(), checkout: unitRoot(), bun: process.execPath }), {
    stdin: "ignore", env,
  });

  if (started.exitCode !== 0) {
    console.error(`reference-round: the unit could not be started: ${started.stderr.toString().trim()}`);
    process.exit(1);
  }

  console.log(`round started as ${roundUnit}. Log: journalctl --user -u ${roundUnit} -f`);
  process.exit(0);
}

const say = (line: string) => console.log(line);
const askedAt = lastOf(reading, "--asked") ?? new Date().toISOString();
const waitedMs = await waitQuiet({ spare, read: readQuiet, wait: (ms) => Bun.sleep(ms), say, memoryBytes: roundMemoryBytes });
const started = new Date().toISOString();

async function step(args: string[]): Promise<StepRecord> {
  const begun = performance.now();
  const child = Bun.spawn([process.execPath, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const exit = await child.exited;

  return { seconds: Math.round((performance.now() - begun) / 1000), exit };
}

// The name this round's training pass will take, read before it runs.
const source = referenceSource(run);
const trainingRun = passName(source.name, nextPass(readCurve(dataPath("laya-curve", source.name))));

say(`data assembly starts (${run}).`);
const data = await step(["scripts/reference-data.ts", run]);
say(`data assembly ended in ${data.seconds}s (exit ${data.exit}).`);

// A data pass that failed leaves the last good pass's rows in place, and the training trains on those.
say("training starts.");
const training = await step(["scripts/laya-train.ts", `reference:${run}`, "--give-way", ...spare.flatMap((unit) => ["--spare", unit])]);
say(`training ended in ${training.seconds}s (exit ${training.exit}).`);

const gates = gateSeconds(dataPath("laya-runs", trainingRun));

appendRound(roundFolder(run), {
  asked: askedAt,
  started,
  ended: new Date().toISOString(),
  waitedSeconds: Math.round(waitedMs / 1000),
  data,
  training,
  trainingRun: gates === null ? null : trainingRun,
  gates: gates ?? [],
});

process.exit(training.exit === 0 ? 0 : 1);
