import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitFiles } from "../../../training/tooling/src/laya-frozen";
import { scratchDir } from "../scratch";
import { pointIds, readCurve } from "../../../training/tooling/src/train/curve";
import { unfinishedRow } from "../../../training/tooling/src/train/gate-run";
import { runPass } from "../../../training/tooling/src/train/pass";
import { copyGateRows } from "../../../training/tooling/src/train/source";

import type { DatasetSplit } from "../../../training/tooling/src/laya-dataset";
import type { CardRead } from "../../../training/tooling/src/laya-nodes";
import type { LedgerRow } from "../../../training/tooling/src/train/ledger";
import type { PassHands, PassOptions } from "../../../training/tooling/src/train/pass";
import type { GateSource } from "../../../training/tooling/src/train/source";
import { useToolingSettings } from "../settings";

useToolingSettings();

const root = scratchDir("bmo-train-pass-");
let made = 0;

function folder(): string {
  made += 1;
  const where = join(root, `case-${made}`);

  mkdirSync(where, { recursive: true });

  return where;
}

// A source holding the gates it is given, `rows` rows each split among the three.
function source(where: string, gates: Record<string, number>, bars = { floor: 10, rarer: 0 }): GateSource {
  for (const [gate, rows] of Object.entries(gates)) {
    const lines: Record<DatasetSplit, string[]> = { train: [], calibration: [], test: [] };

    for (let at = 0; at < rows; at += 1) {
      const split: DatasetSplit = at % 5 === 0 ? "test" : at % 5 === 1 ? "calibration" : "train";

      lines[split].push(JSON.stringify({ id: `${gate}-${at}`, gate, split, state: "\"s\"", questions: "{}", gold: "{}" }));
    }

    mkdirSync(join(where, gate), { recursive: true });

    for (const [split, file] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
      writeFileSync(join(where, gate, file), `${lines[split].join("\n")}\n`);
    }
  }

  return {
    name: "src-1",
    rehearsal: false,
    counts: () => Object.entries(gates).map(([gate, rows]) => ({
      gate, rows: { train: rows - 2 * Math.ceil(rows / 5), calibration: Math.ceil(rows / 5), test: Math.ceil(rows / 5) }, rarer: 0, series: "",
    })),
    bars: () => bars,
    copy: (gate, to) => copyGateRows(join(where, gate), gate, to),
  };
}

// A node's card at each reading of it, the last standing for every reading after; a node not named
// stands free throughout.
type Cards = Record<string, readonly CardRead[]>;

function hands(nodes: string[], ran: string[], state: LedgerRow["state"] = "done", cards: Cards = {}): PassHands {
  const reads = new Map<string, number>();

  return {
    nodes: async () => nodes,
    card: async (node) => {
      const seen = cards[node] ?? [{ state: "free" }];
      const at = reads.get(node) ?? 0;

      reads.set(node, at + 1);

      return seen[Math.min(at, seen.length - 1)]!;
    },
    beside: async (gate) => gate === "a" ? "a/real-1/step-000001" : null,
    runGate: async (gate, node, round, run) => {
      ran.push(`${gate}@${node}#${round} ${run.beside ?? "-"}`);

      return { ...unfinishedRow(gate, node, round, { pass: run.pass, rehearsal: false, beside: run.beside }, "t"), state, fault: state === "done" ? null : "broke" };
    },
  };
}

function options(where: string, source: GateSource, passHands: PassHands, changes: Partial<PassOptions> = {}): PassOptions {
  return {
    source, curve: join(where, "curve"), passFolder: (pass) => join(where, "runs", pass), gates: null, dryRun: false, hands: passHands,
    now: () => new Date("2026-09-25T00:00:00Z"), ...changes,
  };
}

describe("runPass", () => {
  test("trains the gates past their floor over the nodes, and writes the ledger, the tables and a point with its ids", async () => {
    const where = folder();
    const ran: string[] = [];
    const report = await runPass(options(where, source(join(where, "data"), { a: 20, b: 20, small: 3 }), hands(["alpha"], ran)));
    const points = readCurve(join(where, "curve"));

    expect(report.train).toEqual(["a", "b"]);
    expect(report.waiting.map((one) => one.gate)).toEqual(["small"]);
    expect(ran).toEqual(["a@alpha#1 a/real-1/step-000001", "b@alpha#2 -"]);
    expect(points.map((point) => [point.gate, point.rows, point.training])).toEqual([["a", 20, "src-1-p0001"], ["b", 20, "src-1-p0001"]]);
    expect(pointIds(join(where, "curve"), points[0]!)!.size).toBe(20);
    expect(readFileSync(join(where, "runs", "src-1-p0001", "tables.md"), "utf8")).toContain("## Before and after");
    expect(existsSync(join(where, "runs", "src-1-p0001", "gates", "a", splitFiles.train))).toBe(true);
  });

  test("trains nothing again until a quarter of the rows are new, and writes nothing meanwhile", async () => {
    const where = folder();
    const data = join(where, "data");

    await runPass(options(where, source(data, { a: 20 }), hands(["alpha"], [])));

    const ran: string[] = [];
    const report = await runPass(options(where, source(data, { a: 20 }), hands(["alpha"], ran)));

    expect(ran).toEqual([]);
    expect(report.waiting[0]!.reason).toContain("the next from 5");
    expect(existsSync(join(where, "runs", "src-1-p0002"))).toBe(false);
  });

  test("a dry run chooses and leaves nothing behind", async () => {
    const where = folder();
    const ran: string[] = [];
    const report = await runPass(options(where, source(join(where, "data"), { a: 20 }), hands(["alpha"], ran), { dryRun: true }));

    expect([report.train, ran, readCurve(join(where, "curve"))]).toEqual([["a"], [], []]);
    expect(existsSync(join(where, "runs"))).toBe(false);
  });

  test("a node whose gate failed takes no other, and a gate no node took keeps its line", async () => {
    const where = folder();
    const ran: string[] = [];
    const report = await runPass(options(where, source(join(where, "data"), { a: 20, b: 20 }), hands(["alpha"], ran, "failed")));

    expect(ran).toHaveLength(1);
    expect(report.ledger!.rows.map((row) => [row.gate, row.state, row.fault])).toEqual([["a", "failed", "broke"], ["b", "failed", "No node was left to take it."]]);
  });

  test("a card taken between two gates is waited on, and the node takes the next gate once it stands free", async () => {
    const where = folder();
    const ran: string[] = [];
    const said: string[] = [];
    const waits: number[] = [];
    const taken: CardRead = { state: "taken", why: "the card carries 1 process" };
    const report = await runPass(options(where, source(join(where, "data"), { a: 20, b: 20 }), hands(["bravo"], ran, "done", {
      bravo: [{ state: "free" }, taken, taken, { state: "free" }],
    }), { say: (line) => said.push(line), wait: async (ms) => { waits.push(ms); }, cardEveryMs: 7 }));

    expect(ran).toEqual(["a@bravo#1 a/real-1/step-000001", "b@bravo#2 -"]);
    expect(waits).toEqual([7, 7]);
    expect(said.filter((line) => line.startsWith("bravo:"))).toEqual(["bravo: waiting for its card to free: the card carries 1 process"]);
    expect(report.ledger!.rows.map((row) => row.state)).toEqual(["done", "done"]);
  });

  test("a node whose card stays taken drops out after the bound, and the gate it did not take keeps its line", async () => {
    const where = folder();
    const ran: string[] = [];
    const said: string[] = [];
    const waits: number[] = [];
    const report = await runPass(options(where, source(join(where, "data"), { a: 20, b: 20 }), hands(["bravo"], ran, "done", {
      bravo: [{ state: "free" }, { state: "taken", why: "the card carries 1 process" }],
    }), { say: (line) => said.push(line), wait: async (ms) => { waits.push(ms); }, cardPolls: 3 }));

    expect(ran).toEqual(["a@bravo#1 a/real-1/step-000001"]);
    expect(waits).toHaveLength(3);
    expect(said).toContain("bravo: its card did not free, so it is left out of this pass: the card carries 1 process");
    expect(report.ledger!.rows.map((row) => [row.gate, row.state, row.fault])).toEqual([["a", "done", null], ["b", "failed", "No node was left to take it."]]);
  });

  test("the gates go to the nodes whose cards stand free, and a node that does not answer the reading drops out at once", async () => {
    const where = folder();
    const ran: string[] = [];
    const said: string[] = [];
    const report = await runPass(options(where, source(join(where, "data"), { a: 20, b: 20, c: 20 }), hands(["alpha", "bravo", "charlie"], ran, "done", {
      bravo: [{ state: "taken", why: "the card carries 1 process" }],
      charlie: [{ state: "silent", why: "the node does not answer — hub down" }],
    }), { say: (line) => said.push(line), wait: async () => {}, cardPolls: 1_000 }));

    expect(ran.every((one) => one.includes("@alpha#"))).toBe(true);
    expect(report.ledger!.rows.map((row) => [row.gate, row.node, row.state])).toEqual([["a", "alpha", "done"], ["b", "alpha", "done"], ["c", "alpha", "done"]]);
    expect(said).toContain("charlie: left out of this pass: the node does not answer — hub down");
  });

  test("says so where no node is ready, and keeps no pass folder", async () => {
    const where = folder();
    const report = await runPass(options(where, source(join(where, "data"), { a: 20 }), hands([], [])));

    expect(report.fault).toBe("No node is ready to train on.");
    expect(existsSync(join(where, "runs", "src-1-p0001"))).toBe(false);
  });
});
