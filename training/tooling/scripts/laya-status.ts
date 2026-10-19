import { existsSync } from "node:fs";

import { readRunStanding, standingLines } from "../src/gate-run";
import { asksUsage, allOf, asked, readFlags } from "../src/flags";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { runFolder } from "../src/roots";

import type { GateSynthesis } from "../src/laya-synth";

// How far a run got, read straight off its folders. It asks the run nothing and holds nothing up:
// a gate writes its progress after every batch, so the folder is the account of it whether the
// run is still going, finished, or was killed an hour ago.

const usage = `usage: bun scripts/laya-status.ts <run> [--gate <gate>]… [--json]

Opens a run folder and says, gate by gate, how many batches are frozen, how many rows it holds, and how many
batches were lost and rows refused.
<run> is a name under the runtime data root or an absolute path.
--gate looks at that gate alone. Every gate where none is given.
--json prints the figures as they stand.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--gate": true, "--json": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-status: ${reading.trouble ?? "give one run to look at."}`);
  console.error(usage);
  process.exit(2);
}

const root = runFolder(reading.loose[0]!);

if (!existsSync(root)) {
  console.error(`laya-status: ${root} does not exist.`);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");
const gates: GateSynthesis[] = wanted.length === 0
  ? [...gateSyntheses()]
  : wanted.map((name) => {
      const spec = synthesisFor(name);

      if (spec === null) {
        console.error(`laya-status: ${name}: no such gate. Choose among: ${gateSyntheses().map((one) => one.gate).join(", ")}`);
        process.exit(2);
      }

      return spec;
    });

const standing = readRunStanding(root, gates);

if (asked(reading, "--json")) {
  console.log(JSON.stringify(standing, null, 2));
} else {
  console.log(root);
  console.log(standingLines(standing).join("\n"));
}
