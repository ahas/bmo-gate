import { existsSync } from "node:fs";

import { auditFrozen, auditLines, freshSeed } from "../src/laya-audit";
import { gatesToRebuild, judgedNothing, verdictLines, verdictsFor } from "../src/gate-verdict";
import { asksUsage, allOf, asked, lastOf, readFlags } from "../src/flags";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { runFolder } from "../src/roots";

// What a frozen dataset is worth, per gate, and whether each gate clears the bars the
// specification fixes. A gate that does not is named for what it missed and by how much, which is
// what tells anybody rebuilding it what to expect to be different.

const usage = `usage: bun scripts/laya-audit.ts <folder> [--gate <gate>]… [--sample <n>] [--seed <seed>] [--json]

Measures a frozen data folder gate by gate, and judges whether its yield, format, answer balance, language,
repeats and floors clear the bars.
<folder> is a name under the runtime data root or an absolute path.
--sample is the rows sampled a gate (default 200); 0 is every row.
--seed draws the same sample again with that seed. Without it a fresh one is made and written with the figures.
--json prints the figures and the verdicts as they stand.

Ends with 1 where a gate did not clear the bars.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--gate": true, "--sample": true, "--seed": true, "--json": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-audit: ${reading.trouble ?? "give one folder to audit."}`);
  console.error(usage);
  process.exit(2);
}

const folder = runFolder(reading.loose[0]!);

if (!existsSync(folder)) {
  console.error(`laya-audit: ${folder} does not exist.`);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");

for (const gate of wanted) {
  if (synthesisFor(gate) === null) {
    console.error(`laya-audit: ${gate}: no such gate. Choose among: ${gateSyntheses().map((one) => one.gate).join(", ")}`);
    process.exit(2);
  }
}

const audit = auditFrozen({
  folder,
  sample: Number(lastOf(reading, "--sample") ?? "200"),
  seed: lastOf(reading, "--seed") ?? freshSeed(),
  gates: wanted,
});

const verdicts = verdictsFor(audit);

if (asked(reading, "--json")) {
  console.log(JSON.stringify({ audit, verdicts }, null, 2));
} else {
  console.log(auditLines(audit).join("\n"));
  console.log("");
  console.log(verdictLines(verdicts).join("\n"));
}

if (judgedNothing(verdicts)) {
  console.error(`laya-audit: no gate to measure was found under ${folder}.`);
  process.exit(1);
}

if (gatesToRebuild(verdicts).length > 0) {
  process.exit(1);
}
