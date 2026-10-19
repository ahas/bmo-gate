import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { claimGate, releaseGate } from "../src/gate-claim";
import { appendLabels, correctedLabels, labelKey, readLabels } from "../src/reference/labels";
import { dataPath, refuseInsideCheckout } from "../src/roots";

// Verdicts settled outside a pass, appended to a reference run's labels as corrections
// (docs/reference-data.md, 「Correcting labels」). Nothing is judged and nothing is trained.

const usage = `usage: bun scripts/reference-correct.ts <run> <corrections.jsonl> --by '<what settled them>' [--dry-run]

Appends one corrected label per line of <corrections.jsonl> to the run's labels.jsonl
(docs/reference-data.md, "Correcting labels"). Each line is a JSON object with turn, gate, slug and word;
the key must already have a label, and the word must be one offered for its kind (attached or offered).
Any line that cannot stand refuses the whole file and nothing is written.
<run> is a name under the runtime data root's reference-data/ or an absolute path.
--by names what settled the verdicts, kept on every corrected label.
--dry-run reads and checks the file and says what would change, writing nothing.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--by": true, "--dry-run": false });
const by = lastOf(reading, "--by")?.trim() ?? "";

if (!reading.ok || reading.loose.length !== 2 || by === "") {
  console.error(`reference-correct: ${reading.trouble ?? "give the run, the corrections file and --by."}`);
  console.error(usage);
  process.exit(2);
}

const [name, file] = reading.loose as [string, string];
const root = name.startsWith("/") ? name : dataPath("reference-data", name);
const refusal = refuseInsideCheckout(root);

if (refusal !== null) {
  console.error(refusal);
  process.exit(2);
}

const labelsPath = join(root, "labels.jsonl");

if (!existsSync(labelsPath)) {
  console.error(`reference-correct: ${labelsPath} does not exist.`);
  process.exit(2);
}

if (!existsSync(file)) {
  console.error(`reference-correct: ${file} does not exist.`);
  process.exit(2);
}

// The run's claim, as a pass takes it: a pass chooses what to judge as it starts, and a label it
// judged after the correction would stand over it.
const standingClaim = claimGate(join(root, "claim"));

if (standingClaim !== null) {
  console.error(`reference-correct: a pass holds the run; try again once it ends.\n${standingClaim}`);
  process.exit(1);
}

process.on("exit", () => releaseGate(join(root, "claim")));

const standing = readLabels(labelsPath);
const read = correctedLabels(readFileSync(file, "utf8"), standing, by, new Date().toISOString());

if ("refused" in read) {
  console.error(`reference-correct: ${read.refused.length} line(s) refused, nothing written:`);

  for (const line of read.refused) {
    console.error(`  ${line}`);
  }

  process.exit(1);
}

const moves = new Map<string, number>();

for (const one of read.labels) {
  const before = standing.get(labelKey(one.turn, one.gate, one.slug))!.word;
  const move = `${before} -> ${one.word}`;

  moves.set(move, (moves.get(move) ?? 0) + 1);
}

for (const [move, count] of [...moves].sort()) {
  console.log(`${String(count).padStart(5)}  ${move}`);
}

if (asked(reading, "--dry-run")) {
  console.log(`${read.labels.length} correction(s) read; nothing written (--dry-run).`);
  process.exit(0);
}

appendLabels(labelsPath, read.labels);
console.log(`${read.labels.length} corrected label(s) appended to ${labelsPath}.`);
