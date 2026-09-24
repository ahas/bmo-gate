import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendCurve, nextPass, passName, pointIds, readCurve } from "./curve";
import { passTables } from "./evaluate";
import { unfinishedRow } from "./gate-run";
import { writeLedger } from "./ledger";
import { floorReason, retrainReason, seriesOf } from "./readiness";
import { totalRows } from "./source";

import type { CurvePoint } from "./curve";
import type { Ledger, LedgerRow } from "./ledger";
import type { Waiting } from "./readiness";
import type { GateCopy, GateSource } from "./source";

// One training pass over a source (docs/training.md, 「A pass」): which gates are trained and why the
// rest wait, each chosen gate's rows copied into the pass's own folder, the gates queued over the
// nodes that are ready, and the ledger, the curve and the tables written. Everything that reaches a
// node is handed in, so a pass is driven from a test without one.

export interface PassHands {
  // The nodes ready to take a gate now.
  nodes: () => Promise<string[]>;
  // The collected checkpoint a gate is measured beside, or null for the one it is trained from.
  beside: (gate: string) => Promise<string | null>;
  runGate: (gate: string, node: string, round: number, run: { pass: string; folder: string; beside: string | null }) => Promise<LedgerRow>;
}

export interface PassOptions {
  source: GateSource;
  // Where the source's curve is kept, and where a pass's folder goes.
  curve: string;
  passFolder: (pass: string) => string;
  // The gates the pass is narrowed to, or null for every gate of the source.
  gates: readonly string[] | null;
  dryRun: boolean;
  hands: PassHands;
  now?: () => Date;
  say?: (line: string) => void;
}

export interface PassReport {
  pass: number | null;
  training: string | null;
  train: string[];
  waiting: Waiting[];
  ledger: Ledger | null;
  fault: string | null;
}

// The gates queued over the nodes: each node takes the next gate waiting the moment its own is done,
// and a node whose gate did not finish takes no other, since a node failing in seconds would
// otherwise take every gate still waiting and fail each of them the same way.
export async function queueGates(
  gates: readonly string[],
  nodes: readonly string[],
  run: (gate: string, node: string, round: number) => Promise<LedgerRow>,
  unclaimed: (gate: string) => LedgerRow,
): Promise<LedgerRow[]> {
  const waiting = [...gates];
  const driven = new Map<string, LedgerRow>();

  await Promise.all(nodes.map(async (node) => {
    for (let round = 1; ; round += 1) {
      const gate = waiting.shift();

      if (gate === undefined) {
        return;
      }

      const row = await run(gate, node, round);

      driven.set(gate, row);

      if (row.state !== "done") {
        return;
      }
    }
  }));

  return gates.map((gate) => driven.get(gate) ?? unclaimed(gate));
}

export async function runPass(options: PassOptions): Promise<PassReport> {
  const now = options.now ?? (() => new Date());
  const say = options.say ?? (() => {});
  const counts = options.source.counts();
  const empty: PassReport = { pass: null, training: null, train: [], waiting: [], ledger: null, fault: null };

  if (typeof counts === "string") {
    return { ...empty, fault: counts };
  }

  const points = readCurve(options.curve);
  const pass = nextPass(points);
  const training = passName(options.source.name, pass);
  const folder = options.passFolder(training);
  const staging = options.dryRun ? mkdtempSync(join(tmpdir(), "bmo-gate-pass-")) : join(folder, "gates");
  const waiting: Waiting[] = [];
  const chosen: { gate: string; series: string; copy: GateCopy }[] = [];

  try {
    for (const count of counts.filter((one) => options.gates === null || options.gates.includes(one.gate))) {
      const rows = totalRows(count.rows);
      const below = floorReason(count, options.source.bars(count.gate));

      if (below !== null) {
        waiting.push({ gate: count.gate, rows, reason: below });
        continue;
      }

      const copy = options.source.copy(count.gate, join(staging, count.gate));

      if (typeof copy === "string") {
        waiting.push({ gate: count.gate, rows, reason: copy });
        continue;
      }

      const reason = retrainReason(
        { rows: totalRows(copy.rows), ids: new Set(copy.ids), digest: copy.digest },
        seriesOf(points, count.gate, count.series),
        (point) => pointIds(options.curve, point),
      );

      if (reason === null) {
        chosen.push({ gate: count.gate, series: count.series, copy });
      } else {
        rmSync(copy.folder, { recursive: true, force: true });
        waiting.push({ gate: count.gate, rows, reason });
      }
    }
  } finally {
    if (options.dryRun) {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  for (const one of waiting) {
    say(`${one.gate}: ${one.rows}행 — ${one.reason}`);
  }

  const train = chosen.map((one) => one.gate);

  if (chosen.length === 0 || options.dryRun) {
    if (!options.dryRun) {
      rmSync(folder, { recursive: true, force: true });
    }

    return { ...empty, train, waiting };
  }

  const nodes = await options.hands.nodes();

  if (nodes.length === 0) {
    rmSync(folder, { recursive: true, force: true });

    return { ...empty, train, waiting, fault: "학습시킬 노드가 하나도 준비되어 있지 않아요." };
  }

  say(`${pass}회차 (${training}): ${chosen.map((one) => `${one.gate} ${totalRows(one.copy.rows)}행`).join(", ")} — ${nodes.join(", ")}`);

  const started = now().toISOString();
  const besides = new Map(await Promise.all(chosen.map(async (one) => [one.gate, await options.hands.beside(one.gate)] as const)));
  const rows = await queueGates(
    train,
    nodes,
    (gate, node, round) => options.hands.runGate(gate, node, round, {
      pass: training, folder: chosen.find((one) => one.gate === gate)!.copy.folder, beside: besides.get(gate) ?? null,
    }),
    (gate) => ({ ...unfinishedRow(gate, "—", 0, { pass: training, rehearsal: options.source.rehearsal, beside: besides.get(gate) ?? null }, null), fault: "맡을 노드가 남지 않았어요." }),
  );
  const ledger: Ledger = {
    pass: training, source: options.source.name, rehearsal: options.source.rehearsal, started, ended: now().toISOString(), nodes, rows,
  };

  writeLedger(folder, ledger);
  writeFileSync(join(folder, "tables.md"), `${passTables(ledger).join("\n")}\n`);

  const at = now().toISOString();

  appendCurve(options.curve, chosen.map(({ gate, series, copy }) => {
    const row = rows.find((one) => one.gate === gate);
    const point: CurvePoint = {
      pass, at, run: options.source.name, training, gate, started: series,
      rows: totalRows(copy.rows), train: copy.rows.train, calibration: copy.rows.calibration, test: copy.rows.test,
      digest: copy.digest,
      node: row?.node ?? null,
      state: row?.state ?? "failed",
      agreement: row?.calibration?.agreement ?? null,
      balanced: row?.calibration?.balanced ?? null,
      ece: row?.calibration?.ece ?? null,
      seconds: row?.seconds ?? null,
      fault: row === undefined ? "원장에 이 게이트의 줄이 없어요." : row.fault,
    };

    return { point, ids: copy.ids };
  }));

  return { pass, training, train, waiting, ledger, fault: null };
}
