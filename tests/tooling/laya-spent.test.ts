import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  clearNode,
  ledgerNodes,
  listingCommand,
  parseListing,
  readLedgers,
  removeCommand,
  runVerdicts,
  sourceClaimed,
  type RunVerdict,
} from "../../training/tooling/src/laya-spent";
import { scratchDir } from "./scratch";
import { unfinishedRow } from "../../training/tooling/src/train/gate-run";
import { writeLedger } from "../../training/tooling/src/train/ledger";

import type { NodeCalls, RunResult } from "../../training/tooling/src/node-calls";
import type { Ledger, LedgerRow } from "../../training/tooling/src/train/ledger";
import { useToolingSettings } from "./settings";

useToolingSettings();

const root = scratchDir("bmo-laya-spent-");
const COLLECTION = "/data/workbench/worker/laya-checkpoints";

function row(gate: string, node: string, pass: string, change: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ...unfinishedRow(gate, node, 1, { pass, rehearsal: false, beside: null }, "2026-10-01T00:00:00Z"),
    state: "done", steps: 600, collected: [`${COLLECTION}/${gate}/${pass}/step-000600`], ...change,
  };
}

function ledger(pass: string, source: string, rows: LedgerRow[]): Ledger {
  return { pass, source, rehearsal: false, started: "", ended: "", nodes: [...new Set(rows.map((one) => one.node))], rows };
}

const said = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

// A node answering each command from the list in turn, keeping what it was asked.
function node(...answers: RunResult[]): NodeCalls & { asked: string[] } {
  const asked: string[] = [];
  const nothing = async () => said("", 1);

  return {
    asked,
    exec: async (command) => {
      asked.push(command);

      return answers.shift() ?? said("", 1);
    },
    upload: nothing,
    download: nothing,
  };
}

describe("which runs are spent", () => {
  test("only a done run whose final checkpoint came back, of a source no living pass holds, is spent", () => {
    const verdicts = runVerdicts([
      ledger("ref-1-p0041", "ref-1", [
        row("session-summary", "node-a", "ref-1-p0041"),
        row("reply-wanted", "node-a", "ref-1-p0041", { state: "failed", collected: [] }),
        row("output-decide", "node-a", "ref-1-p0041", { collectFault: "\uAC00\uC838\uC624\uC9C0 \uBABB\uD588\uC5B4\uC694" }),
        row("knowledge-classifier", "node-a", "ref-1-p0041", { collected: [`${COLLECTION}/knowledge-classifier/ref-1-p0041/step-000425`] }),
      ]),
      ledger("ref852-p0002", "ref852", [row("session-summary", "bravo", "ref852-p0002")]),
    ], (source) => source === "ref852");

    expect(Object.fromEntries([...verdicts].map(([run, verdict]) => [run, verdict.spent]))).toEqual({
      "ref-1-p0041-session-summary": true,
      "ref-1-p0041-reply-wanted": false,
      "ref-1-p0041-output-decide": false,
      "ref-1-p0041-knowledge-classifier": false,
      "ref852-p0002-session-summary": false,
    });
  });

  test("ledgers and claims are read from the data root as they stand", () => {
    const runs = join(root, "runs");
    const curves = join(root, "curves");

    writeLedger(join(runs, "ref-1-p0041"), ledger("ref-1-p0041", "ref-1", [row("session-summary", "node-a", "ref-1-p0041")]));
    mkdirSync(join(runs, "ref-1-p0042"), { recursive: true });
    mkdirSync(join(curves, "ref-1"), { recursive: true });
    writeFileSync(join(curves, "ref-1", ".writer.1.4242"), "");

    const ledgers = readLedgers(runs);

    expect(ledgers.map((one) => one.pass)).toEqual(["ref-1-p0041"]);
    expect(ledgerNodes(ledgers)).toEqual(["node-a"]);
    expect(sourceClaimed("ref-1", { curves, alive: (pid) => pid === 4242 })).toBe(true);
    expect(sourceClaimed("ref-1", { curves, alive: () => false })).toBe(false);
  });
});

describe("clearing a node", () => {
  const verdicts = new Map<string, RunVerdict>([
    ["ref-1-p0041-session-summary", { spent: true }],
    ["ref-1-p0042-session-summary", { spent: true }],
    ["ref-1-p0041-reply-wanted", { spent: false, why: "\uAC8C\uC774\uD2B8 \uD559\uC2B5\uC774 \uB05D\uB098\uC9C0 \uC54A\uC558\uC5B4\uC694" }],
  ]);
  const listing = [
    "644000000\tcheckpoints/ref-1-p0041-session-summary",
    "90000000\tdata/ref-1-p0041-session-summary",
    "8500000000\tcheckpoints/ref-1-p0042-session-summary",
    "644000000\tcheckpoints/ref-1-p0041-reply-wanted",
    "644000000\tcheckpoints/ref-1-p0043-session-summary",
    "644000000\tcheckpoints/session-summary",
    "running=123 /srv/trainer/bmo-laya/.venv/bin/python finetune.py --resume checkpoints/ref-1-p0042-session-summary",
    "disk=/dev/sda1 1000000000000 600000000000 400000000000 60% /",
    "end=yes",
  ].join("\n");

  test("removes only spent runs no process names, and leaves the service's folders and every other run", async () => {
    const at = node(said(listing), said("removed=ref-1-p0041-session-summary\ndisk=/dev/sda1 1000000000000 599000000000 401000000000 60% /\nend=yes"));
    const cleared = await clearNode({ node: "node-a", calls: at, verdicts });

    expect(at.asked[1]).toBe(removeCommand(["ref-1-p0041-session-summary"]));
    expect(cleared.fault).toBeNull();
    expect(cleared.removed).toEqual(["ref-1-p0041-session-summary"]);
    expect(cleared.freed).toBe(734000000);
    expect(cleared.after?.used).toBe(599000000000);
    expect(cleared.plan.keep.map((one) => one.run)).toEqual(["ref-1-p0041-reply-wanted", "ref-1-p0042-session-summary", "ref-1-p0043-session-summary"]);
  });

  test("a dry run asks the node once and removes nothing", async () => {
    const at = node(said(listing));
    const cleared = await clearNode({ node: "node-a", calls: at, verdicts, dryRun: true });

    expect(at.asked).toHaveLength(1);
    expect(cleared.removed).toEqual(["ref-1-p0041-session-summary"]);
  });

  test("a node whose answer is cut short keeps everything", async () => {
    const at = node(said(listing.replace("end=yes", "")));
    const cleared = await clearNode({ node: "node-b", calls: at, verdicts });

    expect(at.asked).toHaveLength(1);
    expect(cleared.removed).toEqual([]);
    expect(cleared.fault).not.toBeNull();
  });

  test("a name that is not a run's never reaches a removal", () => {
    expect(() => removeCommand(["session-summary"])).toThrow();
    expect(() => removeCommand(["ref-1-p0041-x; rm -rf ~"])).toThrow();
  });
});

// The two commands run in a real shell over a node's folder laid out as a node that also serves keeps it.
describe.each(["bash", "zsh"].filter((shell) => Bun.which(shell) !== null))("on a node's folder, in %s", (shell) => {
  test("lists the run folders through the checkpoints link and removes only the runs named", () => {
    const home = join(root, `home-${shell}`);
    const store = join(home, "store");

    mkdirSync(join(store, "ref-1-p0041-session-summary", "steps", "step-000025"), { recursive: true });
    mkdirSync(join(store, "session-summary", "ref-1-p0041", "step-000600"), { recursive: true });
    writeFileSync(join(store, "ref-1-p0041-session-summary", "model.safetensors"), "w".repeat(4096));
    mkdirSync(join(home, "bmo-laya", "data", "ref-1-p0041-session-summary"), { recursive: true });
    mkdirSync(join(home, "bmo-laya", "data", "ref-1-p0042-reply-wanted"), { recursive: true });
    symlinkSync(store, join(home, "bmo-laya", "checkpoints"));

    const run = (command: string) => Bun.spawnSync([shell, "-c", command], { env: { ...process.env, HOME: home }, stdin: "ignore" }).stdout.toString();
    const listed = parseListing(run(listingCommand()));

    expect(listed?.folders.map((one) => `${one.kind}/${one.name}`).sort()).toEqual([
      "checkpoints/ref-1-p0041-session-summary", "checkpoints/session-summary", "data/ref-1-p0041-session-summary", "data/ref-1-p0042-reply-wanted",
    ]);
    expect(listed?.folders.find((one) => one.name === "ref-1-p0041-session-summary" && one.kind === "checkpoints")!.bytes).toBeGreaterThanOrEqual(4096);
    expect(listed?.disk).not.toBeNull();

    const removed = run(removeCommand(["ref-1-p0041-session-summary"]));

    expect(removed).toContain("removed=ref-1-p0041-session-summary");
    expect(removed).toContain("end=yes");
    expect(existsSync(join(store, "ref-1-p0041-session-summary"))).toBe(false);
    expect(existsSync(join(home, "bmo-laya", "data", "ref-1-p0041-session-summary"))).toBe(false);
    expect(existsSync(join(store, "session-summary", "ref-1-p0041", "step-000600"))).toBe(true);
    expect(existsSync(join(home, "bmo-laya", "data", "ref-1-p0042-reply-wanted"))).toBe(true);
  });
});
