import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitFiles } from "../laya-frozen";
import { scratchDir } from "../scratch";
import { pointIds, readCurve } from "./curve";
import { unfinishedRow } from "./gate-run";
import { runPass } from "./pass";
import { copyGateRows } from "./source";

import type { DatasetSplit } from "../laya-dataset";
import type { LedgerRow } from "./ledger";
import type { PassHands, PassOptions } from "./pass";
import type { GateSource } from "./source";

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

function hands(nodes: string[], ran: string[], state: LedgerRow["state"] = "done"): PassHands {
  return {
    nodes: async () => nodes,
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
    const report = await runPass(options(where, source(join(where, "data"), { a: 20, b: 20, small: 3 }), hands(["n2"], ran)));
    const points = readCurve(join(where, "curve"));

    expect(report.train).toEqual(["a", "b"]);
    expect(report.waiting.map((one) => one.gate)).toEqual(["small"]);
    expect(ran).toEqual(["a@n2#1 a/real-1/step-000001", "b@n2#2 -"]);
    expect(points.map((point) => [point.gate, point.rows, point.training])).toEqual([["a", 20, "src-1-p0001"], ["b", 20, "src-1-p0001"]]);
    expect(pointIds(join(where, "curve"), points[0]!)!.size).toBe(20);
    expect(readFileSync(join(where, "runs", "src-1-p0001", "tables.md"), "utf8")).toContain("## 전과 후");
    expect(existsSync(join(where, "runs", "src-1-p0001", "gates", "a", splitFiles.train))).toBe(true);
  });

  test("trains nothing again until a quarter of the rows are new, and writes nothing meanwhile", async () => {
    const where = folder();
    const data = join(where, "data");

    await runPass(options(where, source(data, { a: 20 }), hands(["n2"], [])));

    const ran: string[] = [];
    const report = await runPass(options(where, source(data, { a: 20 }), hands(["n2"], ran)));

    expect(ran).toEqual([]);
    expect(report.waiting[0]!.reason).toContain("다음은 5개부터");
    expect(existsSync(join(where, "runs", "src-1-p0002"))).toBe(false);
  });

  test("a dry run chooses and leaves nothing behind", async () => {
    const where = folder();
    const ran: string[] = [];
    const report = await runPass(options(where, source(join(where, "data"), { a: 20 }), hands(["n2"], ran), { dryRun: true }));

    expect([report.train, ran, readCurve(join(where, "curve"))]).toEqual([["a"], [], []]);
    expect(existsSync(join(where, "runs"))).toBe(false);
  });

  test("a node whose gate failed takes no other, and a gate no node took keeps its line", async () => {
    const where = folder();
    const ran: string[] = [];
    const report = await runPass(options(where, source(join(where, "data"), { a: 20, b: 20 }), hands(["n2"], ran, "failed")));

    expect(ran).toHaveLength(1);
    expect(report.ledger!.rows.map((row) => [row.gate, row.state, row.fault])).toEqual([["a", "failed", "broke"], ["b", "failed", "맡을 노드가 남지 않았어요."]]);
  });

  test("says so where no node is ready, and keeps no pass folder", async () => {
    const where = folder();
    const report = await runPass(options(where, source(join(where, "data"), { a: 20 }), hands([], [])));

    expect(report.fault).toBe("학습시킬 노드가 하나도 준비되어 있지 않아요.");
    expect(existsSync(join(where, "runs", "src-1-p0001"))).toBe(false);
  });
});
