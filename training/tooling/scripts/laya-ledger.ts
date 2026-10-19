import { existsSync } from "node:fs";

import { ledgerLines, readLedger } from "../src/gate-ledger";
import { asksUsage, allOf, asked, readFlags } from "../src/flags";
import { gateSyntheses, synthesisFor } from "../src/laya-synth";
import { runFolder } from "../src/roots";

import type { GateSynthesis } from "../src/laya-synth";

// What a run made and what it cost, gate by gate.

const usage = `usage: bun scripts/laya-ledger.ts <run> [--gate <gate>]… [--json]

Opens a run folder and gives, gate by gate, a ledger of how many rows it wrote and what it spent.
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
  console.error(`laya-ledger: ${reading.trouble ?? "give one run to look at."}`);
  console.error(usage);
  process.exit(2);
}

const root = runFolder(reading.loose[0]!);

if (!existsSync(root)) {
  console.error(`laya-ledger: ${root} does not exist.`);
  process.exit(2);
}

const wanted = allOf(reading, "--gate");
const gates: GateSynthesis[] = wanted.length === 0
  ? [...gateSyntheses()]
  : wanted.map((name) => {
      const spec = synthesisFor(name);

      if (spec === null) {
        console.error(`laya-ledger: ${name}: no such gate. Choose among: ${gateSyntheses().map((one) => one.gate).join(", ")}`);
        process.exit(2);
      }

      return spec;
    });

const ledger = readLedger(root, gates);

if (typeof ledger === "string") {
  console.error(`laya-ledger: ${ledger}`);
  process.exit(2);
}

console.log(asked(reading, "--json") ? JSON.stringify(ledger, null, 2) : ledgerLines(ledger).join("\n"));
