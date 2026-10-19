import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { dataPath } from "../src/roots";
import { passTables, TABLE_TAU, tablesJson } from "../src/train/evaluate";
import { readLedger } from "../src/train/ledger";

// The tables a pass is judged on (docs/training.md, 「The tables」), assembled from the pass's own
// ledger, which carries the calibration's report, so nothing is read twice and nothing can have moved
// in between.

const usage = `usage: bun scripts/laya-tables.ts <pass> [--tau <n>] [--json] [--out <file>]

Makes the tables out of a training pass's ledger: for each gate, the new checkpoint beside the checkpoint it is
measured against (the one served now, else the training's starting point) on the same test rows — accuracy,
balanced accuracy, yes recall and calibration (ECE) before and after — the asymmetric gates' missed calls at each
threshold, and each node's time taken and VRAM peak. Every line of a rehearsal pass says so.
<pass> is a name under the runtime data root's laya-runs/ or an absolute path.
--tau is the threshold the gate table shows missed calls at (default ${TABLE_TAU}).
Without --out, it is written to tables.md in the pass folder.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--tau": true, "--out": true, "--json": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-tables: ${reading.trouble ?? "give one pass."}`);
  console.error(usage);
  process.exit(2);
}

const name = reading.loose[0]!;
const folder = name.startsWith("/") ? name : dataPath("laya-runs", name);
const ledger = readLedger(folder);

if (ledger === null) {
  console.error(`laya-tables: ${folder} holds no pass ledger.`);
  process.exit(1);
}

const tau = Number(lastOf(reading, "--tau") ?? TABLE_TAU);

if (!Number.isFinite(tau) || tau <= 0 || tau > 1) {
  console.error("laya-tables: --tau is a number between 0 and 1.");
  process.exit(2);
}

if (asked(reading, "--json")) {
  console.log(JSON.stringify(tablesJson(ledger, tau), null, 2));
  process.exit(0);
}

const sheet = passTables(ledger, tau).join("\n");
const where = lastOf(reading, "--out") ?? join(folder, "tables.md");

writeFileSync(where, `${sheet}\n`);
console.log(sheet);
console.error(`tables: ${where}`);
