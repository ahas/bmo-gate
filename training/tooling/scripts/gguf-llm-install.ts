import { asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import {
  ENGINE, GgufRefused, ggufKeyPath, installGguf, instanceOf, modelName, plannedFiles, readEntry, readGgufSettings, registrationAddress,
  uninstallGguf, writePlanned,
} from "../src/gguf-llm";
import { connectionCalls, readConnection, reservedAgainst } from "../src/node-reach";

import type { GgufInstance, GgufSettings } from "../src/gguf-llm";

// A catalogue entry's GGUF model stood up on the node its registration names, or brought up to date there,
// taken down again, or shown as it would be written (docs/gguf-llm.md). The agency's model choice runs it
// with the entry's name; its last line is what the choice records.
//
// usage: bun scripts/gguf-llm-install.ts --model <entry> [--dry-run [--out <folder>] | --uninstall]

const usage = `usage: bun scripts/gguf-llm-install.ts --model <entry> [--dry-run [--out <folder>] | --uninstall]

Stands the catalogue entry's GGUF model up under llama.cpp's server on the node its registration's settings name,
with its tunnel to the operations machine, or brings it up to date there: the model file is fetched where it is
missing and checked against its size and SHA-256, the units are filled from runtime/gguf-llm/'s templates and
started, and once the engine answers through the tunnel the node is recorded in the entry. The last line names the
address the registration reaches it at.
The entry is read through the catalogue verb the settings name, in the archive BMO_DB_PATH names where it is set;
where and how the model is served is the installer's settings, <data root>/env/gguf-llm.toml.
--dry-run writes nothing anywhere and prints every file the install would write, the key standing as the name of
its file; --out also writes them under that folder. --uninstall stops and removes the units, the settings folder
and the tunnel's entry and key; the model files stay on the node.
Run again, it leaves alone what already stands and restarts the units.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--model": true, "--dry-run": false, "--out": true, "--uninstall": false });
const name = lastOf(reading, "--model");

if (reading.trouble !== null || reading.loose.length > 0 || name === undefined
  || (asked(reading, "--dry-run") && asked(reading, "--uninstall")) || (lastOf(reading, "--out") !== undefined && !asked(reading, "--dry-run"))) {
  console.error(`${ENGINE}-install: ${reading.trouble ?? (reading.loose.length > 0 ? `arguments that are not options — ${reading.loose.join(" ")}` : "the options do not go together")}`);
  console.error(usage);
  process.exit(2);
}

function fail(said: string, code = 1): never {
  console.error(`${ENGINE}-install: ${said}`);
  process.exit(code);
}

let settings: GgufSettings;
try {
  settings = readGgufSettings();
} catch (cause) {
  fail(cause instanceof Error ? cause.message : String(cause), 2);
}

const entry = await readEntry(settings, name, spawnRunner);
if (typeof entry === "string") {
  fail(entry);
}

let instance: GgufInstance;
try {
  instance = instanceOf(entry, settings);
} catch (cause) {
  fail(cause instanceof GgufRefused ? cause.message : String(cause), 2);
}

const { serving } = instance;
const connection = await readConnection(serving.node, spawnRunner);
if (typeof connection === "string") {
  fail(connection);
}

if (asked(reading, "--dry-run")) {
  const files = plannedFiles(instance);
  for (const file of files) {
    console.log(`=== ${file.side === "node" ? `${serving.node}:~/` : ""}${file.path} (${file.mode})`);
    process.stdout.write(file.text.endsWith("\n") ? file.text : `${file.text}\n`);
  }
  const out = lastOf(reading, "--out");
  if (out !== undefined) {
    writePlanned(files, out);
    console.log(`The files stand under ${out} as well.`);
  }
  const refused = reservedAgainst(ENGINE, serving.node, connection);
  if (refused !== null) {
    console.log(`An install would be refused: ${refused}.`);
  }
  console.log(`Nothing was written. ${entry.name} would be served on ${serving.node} as ${modelName(entry)}, `
    + `reached at ${registrationAddress(serving)} with the key in ${ggufKeyPath(serving)}.`);
  process.exit(0);
}

const calls = connectionCalls(connection, spawnRunner, nodeConsole());

if (asked(reading, "--uninstall")) {
  const outcome = await uninstallGguf(instance, { runner: spawnRunner, console: nodeConsole(), calls, say: (line) => console.log(line) });
  if (!outcome.ok) {
    fail(`${serving.node} stopped at ${outcome.step} — ${outcome.fault}`);
  }
  console.log(`The registration ${serving.registration} is served on ${serving.node} no longer.`);
  process.exit(0);
}

const outcome = await installGguf(instance, {
  runner: spawnRunner, console: nodeConsole(), calls, role: connection.role, settings, say: (line) => console.log(line),
});
if (!outcome.ok) {
  fail(`${serving.node} stopped at ${outcome.step} — ${outcome.fault}`);
}
console.log(`The registration ${serving.registration} answers on ${serving.node} at ${registrationAddress(serving)} `
  + `as ${modelName(entry)}, with the key in ${ggufKeyPath(serving)}.`);
