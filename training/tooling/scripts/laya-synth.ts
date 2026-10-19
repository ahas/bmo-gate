import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { claudeAccount, claudeAsker, claudeConfigDir, claudeEffort, claudeModel, claudeTimeoutMs } from "../src/claude-road";
import { codexAsker, codexEffort, codexModel, codexTimeoutMs, emptyCwd } from "../src/codex-road";
import { localAsker, localEffort, localModel, localTimeoutMs } from "../src/local-road";
import { textAsker, textEffort, textTimeoutMs, textBaseUrl, textModel } from "../src/text-road";
import { driveGates } from "../src/gate-run";
import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { answersOf, gatesChosen } from "../src/laya-synth";
import { refuseInsideCheckout, runFolder } from "../src/roots";

import type { SynthAsker, SynthRoad } from "../src/laya-synth-run";

// The gates' distilled data, written on the codex account (docs/gate-data.md). One gate to a
// thread, all of them at once, every one frozen a batch at a time into a folder of its own.
//
// The run is meant to be left going. It is hours at the full row count, so it writes its own log
// beside the data and a gate's progress lands after every batch: `laya-status.ts` reads how far it
// got without attaching to anything.

// The specification's own figures. Neither is this command's to choose.
const defaultRows = 7_500;
const defaultBatch = 20;

const usage = `usage: bun scripts/laya-synth.ts --run <name> [--gate <gate>]… [--except <gate>]…
                                 [--rows <n>] [--batch <n>]
                                 [--road codex|local|claude|text] [--top-up <answer>] [--at-once <n>]
                                 [--model <model>] [--effort <effort>] [--timeout <seconds>] [--resume] [--overwrite]

Writes the distilled data one held thread a gate, and freezes it under the run folder <name>.
--run is a name under the runtime data root or an absolute path. Nothing is written inside the checkout.
--gate picks a gate to write (many times). Every gate where none is given.
--except leaves a gate out (many times), such as one another run is writing on a road of its own.
--rows is the rows a gate (default ${defaultRows}); --batch the rows asked at once (default ${defaultBatch}).
--road is codex (the default, holding a thread and reading its cache) or local (the local-model road:
  no session and no cache), which takes up a gate the codex account refuses at the account level.
  claude is the road pinned to the Claude login the settings name, for while codex is shut. No session
  and no cache.
  text is the text model road, the OpenAI-compatible front the settings name. No session and no cache;
  a busy card's 503 is waited out a while and asked again.
  The sanitiser gate is not written by this driver: it is built by its own harvest, which this
  repository does not carry (docs/gate-data.md, 「The sanitiser gate's own build」).
--top-up writes every batch with this one answer and puts no row in the test. It adds the rare answer a
  real judging run is short of to training and calibration (docs/gate-data.md, 「Invented data」).
--at-once is how many gates are written at once (default: every gate chosen).
--resume takes a run cut off part way up from the next batch, leaving gates already frozen as they are.
  Taken up on another road, the frozen batches stand and the batches after them ride the new road.
--overwrite removes the gate folders and writes them again from the start.
With neither, nothing is written into a folder that is not empty.

To start it in the background:
  setsid bun scripts/laya-synth.ts --run <name> </dev/null >/dev/null 2>&1 &`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--run": true, "--gate": true, "--except": true, "--rows": true, "--batch": true, "--road": true, "--top-up": true, "--at-once": true,
  "--model": true, "--effort": true, "--timeout": true, "--resume": false, "--overwrite": false,
});

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-synth: ${reading.trouble ?? `${reading.loose.join(" ")}: not understood.`}`);
  console.error(usage);
  process.exit(2);
}

const named = lastOf(reading, "--run");

if (named === undefined) {
  console.error("laya-synth: name the run with --run.");
  process.exit(2);
}

const root = runFolder(named);
const inside = refuseInsideCheckout(root);

if (inside !== null) {
  console.error(`laya-synth: ${inside}`);
  process.exit(2);
}

const chosen = gatesChosen(allOf(reading, "--gate"), allOf(reading, "--except"));

if (typeof chosen === "string") {
  console.error(`laya-synth: ${chosen}`);
  process.exit(2);
}

const gates = chosen;

const road = (lastOf(reading, "--road") ?? "codex") as SynthRoad;

if (road !== "codex" && road !== "local" && road !== "claude" && road !== "text") {
  console.error("laya-synth: --road is one of codex, local, claude, text.");
  process.exit(2);
}

const topUp = lastOf(reading, "--top-up") ?? null;
const unanswerable = topUp === null ? [] : gates.filter((gate) => !answersOf(gate.questions[0]!).includes(topUp));

if (unanswerable.length > 0) {
  console.error(`laya-synth: ${unanswerable.map((gate) => gate.gate).join(", ")} has no answer ${topUp}.`);
  process.exit(2);
}

// Each road brings its own model, its own effort and its own wait, and the asker that speaks it.
const roadDefaults = road === "local"
  ? { model: localModel(), effort: localEffort, timeoutSeconds: localTimeoutMs / 1000 }
  : road === "text"
    ? { model: textModel(), effort: textEffort, timeoutSeconds: textTimeoutMs / 1000 }
    : road === "claude"
      ? { model: claudeModel, effort: claudeEffort, timeoutSeconds: claudeTimeoutMs / 1000 }
      : { model: codexModel, effort: codexEffort, timeoutSeconds: codexTimeoutMs / 1000 };

const rows = Number(lastOf(reading, "--rows") ?? String(defaultRows));
const batchSize = Number(lastOf(reading, "--batch") ?? String(defaultBatch));
const atOnce = Number(lastOf(reading, "--at-once") ?? String(gates.length));
const model = lastOf(reading, "--model") ?? roadDefaults.model;
const effort = lastOf(reading, "--effort") ?? roadDefaults.effort;
const timeoutMs = Number(lastOf(reading, "--timeout") ?? String(roadDefaults.timeoutSeconds)) * 1000;

for (const [what, value] of [["--rows", rows], ["--batch", batchSize], ["--at-once", atOnce], ["--timeout", timeoutMs]] as const) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`laya-synth: ${what} has to be a number above 0.`);
    process.exit(2);
  }
}

mkdirSync(root, { recursive: true });

// The run's own log, beside the data it makes, so a run left going is readable afterwards however
// it was started and whatever became of the terminal that started it.
const logPath = join(root, "run.log");

function say(line: string): void {
  console.log(line);
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

const started = Date.now();

// The asker for the chosen road. Codex and claude work in a directory holding nothing so no
// checkout's AGENTS.md is carried into a batch; the local-model and text model roads are one request
// over HTTP and have no such directory.
const asker: SynthAsker = road === "local"
  ? localAsker({ model, timeoutMs })
  : road === "text"
    ? textAsker({ model, timeoutMs })
    : road === "claude"
      ? claudeAsker({ model, effort, timeoutMs })
      : codexAsker({ model, effort, timeoutMs });

say(`${root}: ${gates.length} gates, ${rows} rows a gate, ${batchSize} rows a batch, ${Math.min(atOnce, gates.length)} at once.`);
say(road === "local"
  ? `model ${model} (${effort}), road local.`
  : road === "text"
    ? `model ${model} (${effort}), road text: ${textBaseUrl()}.`
    : road === "claude"
      ? `model ${model} (${effort}), road claude: pinned to ${claudeAccount()} in ${claudeConfigDir()}. Working folder ${emptyCwd()}.`
      : `model ${model} (${effort}), road codex. Working folder ${emptyCwd()}.`);

if (topUp !== null) {
  say(`rare answer top-up: every batch is written with ${topUp}, and none goes to the test.`);
}

const outcomes = await driveGates({
  root,
  gates,
  rows,
  batchSize,
  model,
  effort,
  road,
  // A top-up's rows are held out of the test, which is the real rows' alone.
  shares: { calibration: 0.15, test: topUp === null ? 0.15 : 0 },
  topUp,
  atOnce,
  resume: asked(reading, "--resume"),
  overwrite: asked(reading, "--overwrite"),
  say,
}, asker);

say("");
say(`took ${Math.round((Date.now() - started) / 1000)}s.`);

for (const one of outcomes) {
  const figures = one.meta?.gates[0];

  say(
    figures === undefined
      ? `${one.gate}: ${one.state}${one.refusal ?? one.fault ? ` — ${(one.refusal ?? one.fault)!.split("\n")[0]}` : ""}`
      : `${one.gate}: ${figures.rows} rows (train ${figures.splits.train} · calibration ${figures.splits.calibration} · test ${figures.splits.test})`
        + ` · cache reads ${figures.tokens.cacheReadTokens} fresh input ${figures.tokens.inputTokens}`,
  );
}

const stuck = outcomes.filter((one) => one.state === "failed" || one.state === "refused");

if (stuck.length > 0) {
  say(`${stuck.map((one) => one.gate).join(", ")} did not finish. Take it up with --resume.`);
  process.exit(1);
}
