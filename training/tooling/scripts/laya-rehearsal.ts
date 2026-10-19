import { allOf, asksUsage, lastOf, readFlags } from "../src/flags";
import { refuseOverwrite } from "../src/laya-frozen";
import { buildRehearsal, rehearsalLines } from "../src/laya-rehearsal";
import { gateSyntheses } from "../src/laya-synth";
import { dataPath, refuseInsideCheckout } from "../src/roots";

// The rehearsal dataset the training machinery is put through its paces on
// (docs/training.md, 「Rehearsal」): every gate's three splits, written here with
// no model asked and no conversation read, every row marked as a rehearsal.
//
// It is not training data and no figure measured on it is a gate's. What it is for is the resume,
// the driver, the collection and the tables — so all of them are seen working before the distilled
// data is paid for.
//
// usage: bun scripts/laya-rehearsal.ts --out <folder> [--rows <n>] [--seed <n>] [--gate <gate>]… [--overwrite]

const usage = `usage: bun scripts/laya-rehearsal.ts --out <folder> [--rows <n>] [--seed <n>] [--gate <gate>]… [--overwrite]

Writes rehearsal data for each gate. No model is called and no conversation is read: each gate's worked row
of its own specification is varied and passed through that gate's own checks as it stands.
Every row carries the rehearsal mark, and so does the folder. A figure measured on this data is no evidence.
--out not starting with / is written under the runtime data root's laya-rehearsal/<name>.
--rows is the rows each gate starts from (default 60), grown until each of the three splits fills.
--seed makes the same seed give the same data (default 713).
Without --gate every gate is written: ${gateSyntheses().map((one) => one.gate).join(", ")}
A frozen folder is not written over without --overwrite.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--out": true, "--rows": true, "--seed": true, "--gate": true, "--overwrite": false });

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-rehearsal: ${reading.trouble ?? `words that are no option: ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const value = (flag: string) => lastOf(reading, flag) ?? null;
const out = value("--out");

if (out === null) {
  console.error("laya-rehearsal: name the folder to write with --out.");
  console.error(usage);
  process.exit(2);
}

const folder = out.startsWith("/") ? out : dataPath("laya-rehearsal", out);

const inside = refuseInsideCheckout(folder);

if (inside !== null) {
  console.error(inside);
  process.exit(2);
}

const refusal = refuseOverwrite(folder, argv.includes("--overwrite"));

if (refusal !== null) {
  console.error(refusal);
  process.exit(1);
}

const counted = (flag: string, fallback: number) => {
  const said = value(flag);

  return said === null ? fallback : Number(said);
};
const rows = counted("--rows", 60);
const seed = counted("--seed", 713);

if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(seed)) {
  console.error("laya-rehearsal: --rows is a whole number of 1 or more, --seed a whole number.");
  process.exit(2);
}

const built = buildRehearsal({
  folder,
  gates: allOf(reading, "--gate"),
  rows,
  seed,
});

if (typeof built === "string") {
  console.error(`laya-rehearsal: ${built}`);
  process.exit(1);
}

console.log(`written to ${folder}.`);
console.log(rehearsalLines(built).join("\n"));
