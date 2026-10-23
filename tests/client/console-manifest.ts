import { consoleManifest } from "../../client/node_modules/bmo-ui/shared/console-manifest";
import { GATE_API_PREFIX, GATE_SERVICE } from "../../client/app/domain/gates";

// The manifest the gate answered, read through bmo-ui's own reading (bmo-ui's `docs/console-bundles.md`, "What a
// service owes"). The server's test runs this with the paths of the manifest and the words the gate answered; it ends
// 0 where the manifest keeps the contract, every locale of the words holds its title, and it names the service and
// the API prefix the pages call.

const [manifestFile, wordsFile] = process.argv.slice(2);

if (manifestFile === undefined || wordsFile === undefined) {
  throw new Error("Name the manifest's file and the words' file.");
}

const manifest = consoleManifest(await Bun.file(manifestFile).json());
const words = (await Bun.file(wordsFile).json()) as Record<string, Record<string, unknown>>;

function holds(tree: unknown, key: string): boolean {
  let at: unknown = tree;

  for (const part of key.split(".")) {
    if (typeof at !== "object" || at === null || !(part in at)) return false;
    at = (at as Record<string, unknown>)[part];
  }

  return typeof at === "string";
}

const faults: string[] = [];

if (Object.keys(words).length === 0) faults.push("the words hold no locale");

for (const [locale, tree] of Object.entries(words)) {
  if (Object.keys(tree).some((namespace) => namespace !== manifest.name)) faults.push(`${locale} holds keys outside ${manifest.name}`);
  if (!holds(tree, manifest.title)) faults.push(`${locale} holds no ${manifest.title}`);
}

if (manifest.serviceName !== GATE_SERVICE) faults.push(`the pages call ${GATE_SERVICE}, the manifest names ${manifest.serviceName}`);
if (manifest.apiPrefix !== GATE_API_PREFIX) faults.push(`the pages call under ${GATE_API_PREFIX}, the manifest names ${manifest.apiPrefix}`);

if (faults.length > 0) throw new Error(faults.join("; "));

console.log(`the manifest of ${manifest.name} keeps the contract`);
