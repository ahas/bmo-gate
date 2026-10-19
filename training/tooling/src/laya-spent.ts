import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { claimsIn, writerAlive } from "./gate-claim";
import { runFault } from "./node-calls";
import { stepName } from "./laya-collect";
import { NODE_DIR } from "./laya-nodes";
import { dataPath } from "./roots";
import { runName } from "./train/gate-run";
import { readLedger } from "./train/ledger";

import type { NodeCalls } from "./node-calls";
import type { Ledger, LedgerRow } from "./train/ledger";

// The runs already carried back cleared off the nodes (docs/training.md, 「Clearing spent runs off the
// nodes」). A run is spent once its pass's ledger says its final checkpoint came back and no living pass
// can be carrying it on; its folders then go from every node that holds them. What is spent is read from
// the ledgers here, what stands and what is training from the node itself, and a node whose answer
// cannot be read whole keeps everything.

/** The folders a run leaves under the node's own folder, each named for the run. */
export const RUN_FOLDERS = ["checkpoints", "data"] as const;

export type RunFolderKind = (typeof RUN_FOLDERS)[number];

// A run's name as a pass gives it, `<pass>-<gate>` with the pass ending in its number. Nothing else is
// ever put into a removal, and a name that is not this shape is no run's.
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*-p\d{4}-[A-Za-z0-9._-]+$/;

// The training and the calibration as the node's process list shows them. The bracket keeps the shell
// that asks from matching its own command line.
const PROCESSES = "'[f]inetune\\.py|[c]alibrate\\.py'";

const DISK_COMMAND = "df -PB1 checkpoints/ 2>/dev/null | tail -1 | sed 's/^/disk=/'";

export type RunVerdict = { spent: true } | { spent: false; why: string };

/** Every pass's ledger standing under the runs folder, a ledger that cannot be read being none. */
export function readLedgers(runs: string = dataPath("laya-runs")): Ledger[] {
  if (!existsSync(runs)) {
    return [];
  }

  return readdirSync(runs)
    .filter((name) => statSync(join(runs, name)).isDirectory())
    .flatMap((name) => {
      const ledger = readLedger(join(runs, name));

      return ledger === null || ledger.pass === "" ? [] : [ledger];
    });
}

/** Whether a living pass holds the curve of a source, so that a run of it may still be carried on. */
export function sourceClaimed(
  source: string,
  where: { curves: string; alive?: (pid: number) => boolean } = { curves: dataPath("laya-curve") },
): boolean {
  return claimsIn(join(where.curves, source)).some((claim) => (where.alive ?? writerAlive)(claim.pid));
}

function rowVerdict(pass: string, row: LedgerRow): RunVerdict {
  if (row.state !== "done") {
    return { spent: false, why: "the gate's training has not finished" };
  }

  if (row.collectFault !== null) {
    return { spent: false, why: `a collection of it once failed: ${row.collectFault}` };
  }

  const final = `/${row.gate}/${pass}/${stepName(row.steps ?? 0)}`;

  return row.collected.some((folder) => folder.endsWith(final))
    ? { spent: true }
    : { spent: false, why: "nothing records its final checkpoint being collected" };
}

/** What every run a ledger names comes to, by its name on the nodes. */
export function runVerdicts(ledgers: readonly Ledger[], claimed: (source: string) => boolean): Map<string, RunVerdict> {
  const verdicts = new Map<string, RunVerdict>();

  for (const ledger of ledgers) {
    const held = claimed(ledger.source);

    for (const row of ledger.rows) {
      verdicts.set(runName(ledger.pass, row.gate), held
        ? { spent: false, why: `a pass is training on ${ledger.source}` }
        : rowVerdict(ledger.pass, row));
    }
  }

  return verdicts;
}

/** The verdicts as the runtime data root's ledgers and curves stand now. */
export function spentVerdicts(): Map<string, RunVerdict> {
  return runVerdicts(readLedgers(), (source) => sourceClaimed(source));
}

/** Every node a pass has trained on, as its ledger names it. */
export function ledgerNodes(ledgers: readonly Ledger[]): string[] {
  return [...new Set(ledgers.flatMap((ledger) => [...ledger.nodes, ...ledger.rows.map((row) => row.node)]))]
    .filter((node) => node !== "" && node !== "—");
}

export function listingCommand(): string {
  return [
    `cd ~/${NODE_DIR} || exit 1`,
    `find -H ${RUN_FOLDERS.join(" ")} -mindepth 1 -maxdepth 1 -type d -exec du -sb {} + 2>/dev/null`,
    `pgrep -af ${PROCESSES} | sed 's/^/running=/'`,
    DISK_COMMAND,
    "echo end=yes",
  ].join("; ");
}

/** The runs' folders removed, each only where no training or calibration on the node names it then. */
export function removeCommand(runs: readonly string[]): string {
  const strange = runs.filter((run) => !RUN_NAME.test(run));

  if (strange.length > 0) {
    throw new Error(`what is not a run's name is never removed: ${strange.join(", ")}`);
  }

  const folders = RUN_FOLDERS.map((kind) => `"${kind}/$run"`).join(" ");

  return [
    `cd ~/${NODE_DIR} || exit 1`,
    `for run in ${runs.join(" ")}; do if pgrep -af ${PROCESSES} | grep -qF -- "$run"; then echo "busy=$run"; else rm -rf -- ${folders} && echo "removed=$run"; fi; done`,
    DISK_COMMAND,
    "echo end=yes",
  ].join("; ");
}

export interface NodeFolder {
  kind: RunFolderKind;
  name: string;
  bytes: number;
}

export interface Disk {
  size: number;
  used: number;
  avail: number;
}

export interface NodeListing {
  folders: NodeFolder[];
  running: string[];
  disk: Disk | null;
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r$/, ""));
}

function diskOf(line: string): Disk | null {
  const [, size, used, avail] = line.trim().split(/\s+/);
  const read = [size, used, avail].map(Number);

  return read.every((one) => Number.isFinite(one) && one >= 0) && size !== undefined
    ? { size: read[0]!, used: read[1]!, avail: read[2]! }
    : null;
}

/** What the listing said, or null where it did not finish saying it. */
export function parseListing(text: string): NodeListing | null {
  const said = lines(text);

  if (!said.includes("end=yes")) {
    return null;
  }

  const listing: NodeListing = { folders: [], running: [], disk: null };
  const folder = new RegExp(`^(\\d+)\\t(${RUN_FOLDERS.join("|")})/([^/]+)$`);

  for (const line of said) {
    const found = folder.exec(line);

    if (found !== null) {
      listing.folders.push({ kind: found[2] as RunFolderKind, name: found[3]!, bytes: Number(found[1]) });
    } else if (line.startsWith("running=")) {
      listing.running.push(line.slice("running=".length));
    } else if (line.startsWith("disk=")) {
      listing.disk = diskOf(line.slice("disk=".length));
    }
  }

  return listing;
}

export interface NodePlan {
  remove: string[];
  keep: { run: string; why: string }[];
}

/** Which of the node's run folders go and which stay, and why. A folder that is not a run's by its name
 * is no business of this, and a run no ledger names is a pass still going or one cut short. */
export function nodePlan(listing: NodeListing, verdicts: ReadonlyMap<string, RunVerdict>): NodePlan {
  const plan: NodePlan = { remove: [], keep: [] };

  for (const run of [...new Set(listing.folders.map((one) => one.name))].sort()) {
    if (!RUN_NAME.test(run)) {
      continue;
    }

    const verdict = verdicts.get(run);

    if (verdict === undefined) {
      plan.keep.push({ run, why: "it has no ledger: a pass still training or never finished" });
    } else if (!verdict.spent) {
      plan.keep.push({ run, why: verdict.why });
    } else if (listing.running.some((line) => line.includes(run))) {
      plan.keep.push({ run, why: "a training or calibration on the node is using this folder" });
    } else {
      plan.remove.push(run);
    }
  }

  return plan;
}

export interface NodeClearing {
  node: string;
  /** Why nothing, or not everything, was removed, where the node's answer could not be read whole. */
  fault: string | null;
  folders: NodeFolder[];
  plan: NodePlan;
  /** The runs removed, or on a dry run the ones that would be. */
  removed: string[];
  before: Disk | null;
  after: Disk | null;
  /** The bytes of what went, or would go on a dry run, by the listing. */
  freed: number;
}

export interface ClearAsk {
  node: string;
  calls: NodeCalls;
  verdicts: ReadonlyMap<string, RunVerdict>;
  dryRun?: boolean;
}

/** One node cleared of its spent runs, nothing removed where its answer cannot be read whole. */
export async function clearNode(ask: ClearAsk): Promise<NodeClearing> {
  const listed = await ask.calls.exec(listingCommand());
  const listing = parseListing(listed.stdout);
  const cleared: NodeClearing = {
    node: ask.node, fault: null, folders: listing?.folders ?? [], plan: { remove: [], keep: [] }, removed: [],
    before: listing?.disk ?? null, after: null, freed: 0,
  };
  const weigh = (runs: readonly string[]) => cleared.folders.filter((one) => runs.includes(one.name)).reduce((sum, one) => sum + one.bytes, 0);

  if (listing === null) {
    return { ...cleared, fault: `the node's run folders could not all be read, so nothing was removed: ${runFault(listed)}` };
  }

  cleared.plan = nodePlan(listing, ask.verdicts);

  if (ask.dryRun === true || cleared.plan.remove.length === 0) {
    return { ...cleared, removed: cleared.plan.remove, freed: weigh(cleared.plan.remove) };
  }

  const removing = await ask.calls.exec(removeCommand(cleared.plan.remove));
  const said = lines(removing.stdout);
  const removed = said.filter((line) => line.startsWith("removed=")).map((line) => line.slice("removed=".length));

  for (const run of said.filter((line) => line.startsWith("busy=")).map((line) => line.slice("busy=".length))) {
    cleared.plan.keep.push({ run, why: "a training or calibration was using this folder just before the removal" });
  }

  const disk = said.find((line) => line.startsWith("disk="));

  return {
    ...cleared,
    removed,
    after: disk === undefined ? null : diskOf(disk.slice("disk=".length)),
    freed: weigh(removed),
    fault: said.includes("end=yes") ? null : `the node's answer was cut off during the removal: ${runFault(removing)}`,
  };
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)}GB`;

function diskLine(disk: Disk | null): string {
  return disk === null ? "unknown" : `${Math.round(disk.used / disk.size * 100)}% (${gb(disk.used)} / ${gb(disk.size)}, ${gb(disk.avail)} free)`;
}

/** What a node's clearing removed and kept, and the disk before and after. */
export function clearingLines(cleared: NodeClearing, dryRun: boolean): string[] {
  const out = [`${cleared.node}: disk ${diskLine(cleared.before)}${dryRun || cleared.removed.length === 0 ? "" : ` → ${diskLine(cleared.after)}`}`];

  for (const run of cleared.removed) {
    const own = cleared.folders.filter((one) => one.name === run);

    out.push(`  ${dryRun ? "to remove" : "removed"} ${run} ${gb(own.reduce((sum, one) => sum + one.bytes, 0))} (${own.map((one) => `${one.kind} ${gb(one.bytes)}`).join(", ")})`);
  }

  for (const one of cleared.plan.keep) {
    out.push(`  kept ${one.run}: ${one.why}`);
  }

  if (cleared.fault !== null) {
    out.push(`  ${cleared.fault}`);
  }

  out.push(`  ${cleared.removed.length} runs ${dryRun ? "to remove" : "removed"}, ${gb(cleared.freed)}`);

  return out;
}
