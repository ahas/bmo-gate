import { existsSync } from "node:fs";

import { gatesTrainingWouldRefuse, mergeGates, readsAsRehearsal } from "../src/gate-merge";
import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { datasetFolder, runFolder } from "../src/roots";

// The run's gates into the one dataset folder the training driver is handed.

const usage = `usage: bun scripts/laya-merge.ts <run> [--gate <gate>]… [--into <folder>] [--growing] [--overwrite]

Merges the frozen data under a run folder, gate by gate, into one dataset folder.
<run> is a name under the runtime data root or an absolute path.
--gate merges that gate alone. Every frozen gate where none is given (with --growing, every gate that has started judging).
--growing merges a gate still being judged too, cut at its last whole frozen batch. Nothing is written into a gate folder.
--into is the folder merged into (default: dataset under the run folder).
--overwrite writes over a frozen dataset. Without it nothing is written.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--gate": true, "--into": true, "--growing": false, "--overwrite": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-merge: ${reading.trouble ?? "give one run to merge."}`);
  console.error(usage);
  process.exit(2);
}

const root = runFolder(reading.loose[0]!);

if (!existsSync(root)) {
  console.error(`laya-merge: ${root} does not exist.`);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");

for (const gate of wanted) {
  if (synthesisFor(gate) === null) {
    console.error(`laya-merge: ${gate}: no such gate. Choose among: ${gateSyntheses().map((one) => one.gate).join(", ")}`);
    process.exit(2);
  }
}

const into = lastOf(reading, "--into") ?? datasetFolder(root);
const report = mergeGates({
  root,
  into,
  gates: wanted.length === 0 ? null : wanted,
  overwrite: asked(reading, "--overwrite"),
  growing: asked(reading, "--growing"),
});

if (typeof report === "string") {
  console.error(`laya-merge: ${report}`);
  process.exit(2);
}

console.log(`${report.gates.length} gates merged into ${report.folder}.`);
console.log(`train ${report.rows.train} · calibration ${report.rows.calibration} · test ${report.rows.test}`);
console.log(`model ${report.meta.model} (${report.meta.effort}), road ${(report.meta.roads ?? [report.meta.road]).join(", ")}`);
console.log(`cache reads ${report.meta.tokens.cacheReadTokens} fresh input ${report.meta.tokens.inputTokens} output ${report.meta.tokens.outputTokens}`);

if (report.duplicates > 0) {
  console.log(`${report.duplicates} rows stood in two folders and were put in once. See that the folders are not mixed.`);
}

if (readsAsRehearsal(report.folder)) {
  console.error("laya-merge: the merged dataset reads as a rehearsal. The training driver does not take it for real data.");
  process.exit(1);
}

const short = gatesTrainingWouldRefuse(report.folder, report.gates);

if (short.length > 0) {
  console.error(`laya-merge: ${short.join(", ")} has an empty split, which the training driver refuses.`);
  process.exit(1);
}

console.log(`All ${report.gates.length} gates are ready for the training driver.`);
