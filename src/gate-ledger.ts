import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { generationOf } from "./laya-audit";
import { addTokens, metaFile, noTokens, roadsOf } from "./laya-synth-run";
import { gateFolder } from "./roots";
import { readRunStanding } from "./gate-run";

import type { DatasetSplit } from "./laya-dataset";
import type { GateSynthesis } from "./laya-synth";
import type { SynthMeta, SynthRoad, TokenTally } from "./laya-synth-run";

// What a run cost and what it made, gate by gate (docs/gate-data.md 「The ledger」).
//
// The tokens are the whole of what there is to report. This account is a flat-rate ChatGPT login:
// codex counts what a turn read and wrote and there is no per-token charge behind those counts, so
// the ledger says that outright. A road that reports no price announcing it is the same rule the
// specification already holds the J3090 road to — a zero left standing unexplained is read as free.
export const noPriceHere = [
  "이 계정은 정액제 ChatGPT 로그인입니다. codex 는 토큰만 세고 토큰당 값은 매기지 않으므로,",
  "원장에 적히는 것은 토큰뿐이고 값은 없습니다. 0원이 아니라 값이라는 것이 없습니다.",
];

export interface GateLedgerRow {
  gate: string;
  // What the model wrote, and what survived the generator's own filter.
  written: number;
  kept: number;
  splits: Record<DatasetSplit, number>;
  batchesDone: number;
  batchesPlanned: number;
  lostBatches: number;
  refused: Record<string, number>;
  // Fresh input and cache reads stand apart, because holding one thread per gate is what makes
  // them differ and a run that added them together could not show that it had worked.
  tokens: TokenTally;
  seconds: number;
  threadHeld: boolean;
  // The road or roads this gate was written on. More than one for a gate carried across roads.
  roads: SynthRoad[];
}

export interface RunLedger {
  root: string;
  model: string;
  effort: string;
  road: string;
  // Every road any of the run's gates was written on.
  roads: SynthRoad[];
  gates: GateLedgerRow[];
  totals: {
    written: number;
    kept: number;
    batchesDone: number;
    batchesPlanned: number;
    lostBatches: number;
    tokens: TokenTally;
    seconds: number;
  };
}

function metaIn(folder: string): SynthMeta | null {
  const path = join(folder, metaFile);

  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SynthMeta : null;
}

function secondsBetween(from: string | undefined, to: string | undefined): number {
  if (from === undefined || to === undefined) {
    return 0;
  }

  const took = Date.parse(to) - Date.parse(from);

  return Number.isFinite(took) && took > 0 ? Math.round(took / 1000) : 0;
}

// The ledger for a run, read off the folders its gates wrote. A gate that never started is left
// out rather than entered as a row of zeroes, because a row of zeroes reads as a gate that ran and
// produced nothing.
export function readLedger(root: string, gates: readonly GateSynthesis[]): RunLedger | string {
  const standing = readRunStanding(root, gates);
  const rows: GateLedgerRow[] = [];
  let model = "";
  let effort = "";
  let road = "";
  let first = "";
  let last = "";

  for (const one of standing) {
    if (one.state === "not started") {
      continue;
    }

    const folder = gateFolder(root, one.gate);
    const meta = metaIn(folder);
    const generation = generationOf(folder, one.gate);
    const figures = meta?.gates.find((each) => each.gate === one.gate);

    model = meta?.model ?? model;
    effort = meta?.effort ?? effort;
    road = meta?.road ?? road;

    if (meta !== null) {
      first = first === "" || meta.started < first ? meta.started : first;
      last = last === "" || meta.written > last ? meta.written : last;
    }

    rows.push({
      gate: one.gate,
      written: generation?.written ?? one.kept,
      kept: generation?.kept ?? one.kept,
      splits: figures?.splits ?? { train: 0, calibration: 0, test: 0 },
      batchesDone: one.done,
      batchesPlanned: one.planned,
      lostBatches: one.lostBatches,
      refused: one.refused,
      tokens: one.tokens,
      seconds: secondsBetween(meta?.started, meta?.written),
      threadHeld: one.threadHeld,
      roads: meta === null ? [] : roadsOf(meta),
    });
  }

  if (rows.length === 0) {
    return `${root} 아래에 아직 아무 게이트도 시작하지 않았습니다.`;
  }

  return {
    root,
    model,
    effort,
    road,
    roads: [...new Set(rows.flatMap((one) => one.roads))].sort(),
    gates: rows,
    totals: {
      written: rows.reduce((all, one) => all + one.written, 0),
      kept: rows.reduce((all, one) => all + one.kept, 0),
      batchesDone: rows.reduce((all, one) => all + one.batchesDone, 0),
      batchesPlanned: rows.reduce((all, one) => all + one.batchesPlanned, 0),
      lostBatches: rows.reduce((all, one) => all + one.lostBatches, 0),
      tokens: rows.reduce<TokenTally>((all, one) => addTokens(all, one.tokens), noTokens),
      // The run's own wall time, from the first gate starting to the last one finishing, which on
      // a run of gates written beside each other is shorter than their times added together.
      seconds: secondsBetween(first, last),
    },
  };
}

function clock(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}초`;
  }

  return seconds < 3_600 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${Math.floor(seconds / 3_600)}시간 ${Math.floor((seconds % 3_600) / 60)}분`;
}

export function ledgerLines(ledger: RunLedger): string[] {
  const lines = ledger.gates.flatMap((one) => {
    const refused = Object.entries(one.refused).sort(([a], [b]) => a.localeCompare(b))
      .map(([why, count]) => `${why} ${count}`).join(", ");

    return [
      `${one.gate}`,
      `  지은 행 ${one.written} · 산 행 ${one.kept} (학습 ${one.splits.train} · 보정 ${one.splits.calibration} · 시험 ${one.splits.test})`,
      `  묶음 ${one.batchesDone}/${one.batchesPlanned} · 날린 묶음 ${one.lostBatches} · 버린 행 ${refused === "" ? "없음" : refused}`,
      `  새 입력 ${one.tokens.inputTokens} · 캐시읽기 ${one.tokens.cacheReadTokens} · 캐시쓰기 ${one.tokens.cacheWriteTokens} · 출력 ${one.tokens.outputTokens}`,
      `  길 ${one.roads.join(" → ") || "?"} · ${clock(one.seconds)} · ${one.threadHeld ? "실 하나를 붙들었습니다" : "실을 붙들지 않았습니다"}`,
    ];
  });

  return [
    `${ledger.root}`,
    `모델 ${ledger.model} (${ledger.effort}), 길 ${ledger.roads.join(", ") || ledger.road}`,
    "",
    ...lines,
    "",
    `모두 ${ledger.gates.length}게이트 · 지은 행 ${ledger.totals.written} · 산 행 ${ledger.totals.kept}`
      + ` · 묶음 ${ledger.totals.batchesDone}/${ledger.totals.batchesPlanned} · 날린 묶음 ${ledger.totals.lostBatches}`,
    `새 입력 ${ledger.totals.tokens.inputTokens} · 캐시읽기 ${ledger.totals.tokens.cacheReadTokens}`
      + ` · 캐시쓰기 ${ledger.totals.tokens.cacheWriteTokens} · 출력 ${ledger.totals.tokens.outputTokens} · ${clock(ledger.totals.seconds)}`,
    "",
    ...noPriceHere,
  ];
}
