import { auditFloors } from "./laya-audit";

import type { Audit, GateAudit } from "./laya-audit";

// Whether a gate's data is good enough to train on, decided by the code rather than by somebody
// reading a table (docs/gate-data.md 「The bars a gate must clear」).
//
// Nothing here computes a figure. Every one of the five is already in what the audit returns, and
// a sixth invented here would be a bar the specification never set — which is the one thing this
// repository must not do, since the specification is not its to add to.

// Three of them are read off what the model wrote, before the generator threw anything away, and
// two off a sample of what survived. The generator refuses a bad row before it freezes, so the
// frozen rows always conform; what says whether the model was any good is the share it lost on the
// way in, and only the run's own meta still holds that.
export const bars = {
  yield: 0.7,
  formatBreaks: 0.1,
  repeats: 0.05,
  answerDrift: 0.05,
  languageDrift: 0.05,
} as const;

export type Side = "at least" | "at most";

export interface BarMiss {
  bar: string;
  got: number;
  wanted: number;
  side: Side;
  said: string;
}

export interface GateVerdict {
  gate: string;
  passed: boolean;
  missed: BarMiss[];
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function shortOf(got: number, wanted: number): number {
  return round(Math.abs(got - wanted));
}

// The five, each with the figure it reads and which side of the bar it has to be on.
const written = [
  { bar: "수율", side: "at least" as const, wanted: bars.yield, of: (one: GateAudit) => one.generation?.keptShare },
  { bar: "형식 깨짐", side: "at most" as const, wanted: bars.formatBreaks, of: (one: GateAudit) => one.generation?.formatBreakShare },
  { bar: "겹침", side: "at most" as const, wanted: bars.repeats, of: (one: GateAudit) => one.generation?.duplicateShare },
];

const frozen = [
  { bar: "답 비율", side: "at most" as const, wanted: bars.answerDrift, of: (one: GateAudit) => one.balanceDrift },
  { bar: "언어", side: "at most" as const, wanted: bars.languageDrift, of: (one: GateAudit) => one.languageDrift },
];

function missed(bar: string, side: Side, got: number, wanted: number): BarMiss | null {
  if (side === "at least" ? got >= wanted : got <= wanted) {
    return null;
  }

  return {
    bar,
    got,
    wanted,
    side,
    said: `${bar} ${got} — ${side === "at least" ? "적어도" : "많아야"} ${wanted} 여야 하는데 ${shortOf(got, wanted)} 모자랍니다.`,
  };
}

export function verdictFor(one: GateAudit): GateVerdict {
  const misses: BarMiss[] = [];

  // The run's own meta is the only place the written-side figures ever stood. Without it the three
  // are not zero and are not passed — they cannot be read at all, and a gate nobody can judge is
  // not a gate that passed.
  if (one.generation === null) {
    misses.push({
      bar: "지은 것",
      got: 0,
      wanted: 0,
      side: "at least",
      said: "이 실행의 메타가 없어 모델이 지은 것에 대한 수율·형식·겹침을 읽을 수 없습니다.",
    });
  } else {
    for (const check of written) {
      const miss = missed(check.bar, check.side, check.of(one)!, check.wanted);

      if (miss !== null) {
        misses.push(miss);
      }
    }
  }

  for (const check of frozen) {
    const miss = missed(check.bar, check.side, check.of(one), check.wanted);

    if (miss !== null) {
      misses.push(miss);
    }
  }

  // The floors are counted over every row rather than over the sample, and each of the three is
  // named on its own: a gate short of training rows and a gate short of held-out rows are put
  // right by different things.
  for (const [what, got, wanted] of [
    ["학습 행 바닥", one.floors.train, auditFloors.train],
    ["적은 쪽 답 바닥", one.floors.minority, auditFloors.minority],
    ["평가 행 바닥", one.floors.evaluation, auditFloors.evaluation],
  ] as const) {
    if (got < wanted) {
      misses.push({
        bar: what,
        got,
        wanted,
        side: "at least",
        said: `${what} ${got} — 적어도 ${wanted} 이어야 하는데 ${wanted - got} 줄 모자랍니다.`,
      });
    }
  }

  return { gate: one.gate, passed: misses.length === 0, missed: misses };
}

export function verdictsFor(audit: Audit): GateVerdict[] {
  return audit.gates.map(verdictFor);
}

export function verdictLines(verdicts: readonly GateVerdict[]): string[] {
  const lines = verdicts.flatMap((one) => [
    `${one.gate}: ${one.passed ? "PASS" : "FAIL"}`,
    ...one.missed.map((miss) => `  ${miss.said}`),
  ]);

  if (verdicts.length === 0) {
    return [...lines, "", "기준을 잰 게이트가 하나도 없습니다. 굳은 게이트가 있는 폴더인지 보세요."];
  }

  const short = verdicts.filter((one) => !one.passed);

  return [
    ...lines,
    "",
    short.length === 0
      ? `${verdicts.length}게이트 모두 기준을 넘었습니다.`
      : `${short.map((one) => one.gate).join(", ")} 은 기준을 못 넘었습니다. 이 게이트만 다시 지으세요.`,
  ];
}

// The gates to build again, which is what a verdict is for.
export function gatesToRebuild(verdicts: readonly GateVerdict[]): string[] {
  return verdicts.filter((one) => !one.passed).map((one) => one.gate);
}

// Whether the reading came to a verdict at all. A folder holding no frozen gate leaves nothing to
// judge, and a reading with nothing to judge has said nothing about the bars — which must not come
// back reading as every bar cleared. There is no gate to name for a rebuild in that case, so the
// gates to build again cannot carry it and it is asked separately.
export function judgedNothing(verdicts: readonly GateVerdict[]): boolean {
  return verdicts.length === 0;
}
