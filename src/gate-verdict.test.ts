import { describe, expect, test } from "bun:test";

import { auditFloors } from "./laya-audit";
import { bars, gatesToRebuild, judgedNothing, verdictFor, verdictLines, verdictsFor } from "./gate-verdict";

import type { GateAudit, GenerationReading } from "./laya-audit";

// A gate whose every figure clears its bar, which each test then spoils one figure of. Written out
// as the audit's own shape rather than generated, so what each bar is being fed is on the page.
function clears(change: Partial<GateAudit> = {}): GateAudit {
  return {
    gate: "sanitizer",
    known: true,
    rows: 7_000,
    splits: { train: 4_900, calibration: 1_050, test: 1_050 },
    sampled: 200,
    unreadable: 0,
    conforming: 200,
    conformance: 1,
    refused: {},
    transcriptBroken: 0,
    transcriptShare: 0,
    balance: { true: 0.51, false: 0.49 },
    balanceTarget: { true: 0.5, false: 0.5 },
    balanceDrift: 0.01,
    language: { korean: 0.4, english: 0.35, mixed: 0.25 },
    languageTarget: { korean: 0.4, english: 0.35, mixed: 0.25 },
    languageDrift: 0.02,
    sidecarMismatch: 0,
    floors: { train: 4_900, minority: 3_430, evaluation: 1_050, met: true },
    generation: {
      written: 8_000,
      kept: 7_000,
      keptShare: 0.875,
      unreadable: 0,
      refused: {},
      duplicates: 40,
      duplicateShare: 0.005,
      formatBreakShare: 0.01,
    },
    ...change,
  };
}

function wrote(change: Partial<GenerationReading>): Partial<GateAudit> {
  return { generation: { ...clears().generation!, ...change } };
}

describe("a gate that clears every bar", () => {
  test("passes", () => {
    expect(verdictFor(clears()).passed).toBe(true);
  });

  test("is named for nothing, because nothing missed", () => {
    expect(verdictFor(clears()).missed).toEqual([]);
  });

  test("is not one to build again", () => {
    expect(gatesToRebuild([verdictFor(clears())])).toEqual([]);
  });
});

describe("a gate that misses one bar", () => {
  test("a yield under the bar fails and is named", () => {
    const verdict = verdictFor(clears(wrote({ keptShare: 0.69 })));

    expect(verdict.passed).toBe(false);
    expect(verdict.missed).toHaveLength(1);
    expect(verdict.missed[0]).toMatchObject({ bar: "수율", got: 0.69, wanted: bars.yield, side: "at least" });
  });

  test("a yield exactly on the bar passes, because the bar is 'at least'", () => {
    expect(verdictFor(clears(wrote({ keptShare: bars.yield }))).passed).toBe(true);
  });

  test("format breaks over the bar fail and are named", () => {
    const verdict = verdictFor(clears(wrote({ formatBreakShare: 0.11 })));

    expect(verdict.missed).toHaveLength(1);
    expect(verdict.missed[0]).toMatchObject({ bar: "형식 깨짐", got: 0.11, wanted: bars.formatBreaks, side: "at most" });
  });

  test("format breaks exactly on the bar pass, because the bar is 'at most'", () => {
    expect(verdictFor(clears(wrote({ formatBreakShare: bars.formatBreaks }))).passed).toBe(true);
  });

  test("repeats over the bar fail and are named", () => {
    const verdict = verdictFor(clears(wrote({ duplicateShare: 0.06 })));

    expect(verdict.missed).toHaveLength(1);
    expect(verdict.missed[0]).toMatchObject({ bar: "겹침", got: 0.06, wanted: bars.repeats });
  });

  test("answer drift over the bar fails and is named", () => {
    const verdict = verdictFor(clears({ balanceDrift: 0.08 }));

    expect(verdict.missed).toHaveLength(1);
    expect(verdict.missed[0]).toMatchObject({ bar: "답 비율", got: 0.08, wanted: bars.answerDrift });
  });

  test("language drift over the bar fails and is named", () => {
    const verdict = verdictFor(clears({ languageDrift: 0.2 }));

    expect(verdict.missed).toHaveLength(1);
    expect(verdict.missed[0]).toMatchObject({ bar: "언어", got: 0.2, wanted: bars.languageDrift });
  });

  test("the two drifts are held to the dataset's own tolerance, not the looser sounding one", () => {
    // A drift a hundred-row sounding would have let through, which a full run does not.
    expect(verdictFor(clears({ languageDrift: 0.15 })).passed).toBe(false);
    expect(verdictFor(clears({ balanceDrift: 0.15 })).passed).toBe(false);
  });

  test("it says by how much, not only that it missed", () => {
    expect(verdictFor(clears({ languageDrift: 0.2 })).missed[0]!.said).toContain("0.15");
  });
});

describe("a gate short of a floor", () => {
  test("too few training rows fails, and the floor is named", () => {
    const verdict = verdictFor(clears({ floors: { train: 3_999, minority: 3_430, evaluation: 1_050, met: false } }));

    expect(verdict.passed).toBe(false);
    expect(verdict.missed[0]).toMatchObject({ bar: "학습 행 바닥", got: 3_999, wanted: auditFloors.train });
    expect(verdict.missed[0]!.said).toContain("1 줄 모자랍니다");
  });

  test("too few of the rarer answer fails on its own floor", () => {
    const verdict = verdictFor(clears({ floors: { train: 4_900, minority: 999, evaluation: 1_050, met: false } }));

    expect(verdict.missed.map((one) => one.bar)).toEqual(["적은 쪽 답 바닥"]);
  });

  test("too few held out fails on its own floor", () => {
    const verdict = verdictFor(clears({ floors: { train: 4_900, minority: 3_430, evaluation: 999, met: false } }));

    expect(verdict.missed.map((one) => one.bar)).toEqual(["평가 행 바닥"]);
  });

  test("the three floors are named apart, since each is put right by something different", () => {
    const verdict = verdictFor(clears({ floors: { train: 1, minority: 1, evaluation: 1, met: false } }));

    expect(verdict.missed.map((one) => one.bar)).toEqual(["학습 행 바닥", "적은 쪽 답 바닥", "평가 행 바닥"]);
  });

  test("a floor exactly met passes", () => {
    expect(verdictFor(clears({
      floors: { train: auditFloors.train, minority: auditFloors.minority, evaluation: auditFloors.evaluation, met: true },
    })).passed).toBe(true);
  });
});

describe("a gate missing several bars", () => {
  test("every one of them is named rather than the first", () => {
    const verdict = verdictFor(clears({
      balanceDrift: 0.3,
      languageDrift: 0.3,
      generation: { ...clears().generation!, keptShare: 0.2, formatBreakShare: 0.5, duplicateShare: 0.4 },
      floors: { train: 10, minority: 2, evaluation: 3, met: false },
    }));

    expect(verdict.missed.map((one) => one.bar)).toEqual([
      "수율", "형식 깨짐", "겹침", "답 비율", "언어", "학습 행 바닥", "적은 쪽 답 바닥", "평가 행 바닥",
    ]);
  });
});

describe("a gate whose run left no meta", () => {
  test("does not pass, because three of the bars cannot be read at all", () => {
    const verdict = verdictFor(clears({ generation: null }));

    expect(verdict.passed).toBe(false);
    expect(verdict.missed[0]!.said).toContain("읽을 수 없습니다");
  });

  test("the two read off the frozen sample are still judged", () => {
    const verdict = verdictFor(clears({ generation: null, languageDrift: 0.4 }));

    expect(verdict.missed.map((one) => one.bar)).toContain("언어");
  });
});

describe("the verdict over a whole dataset", () => {
  const audit = {
    folder: "/어딘가",
    seed: "씨앗",
    sample: 200,
    gates: [clears(), clears({ gate: "reply-wanted", languageDrift: 0.4 })],
  };

  test("one gate failing does not fail the others", () => {
    expect(verdictsFor(audit).map((one) => one.passed)).toEqual([true, false]);
  });

  test("only the gate that missed is one to build again", () => {
    expect(gatesToRebuild(verdictsFor(audit))).toEqual(["reply-wanted"]);
  });

  test("what is said names the gate to rebuild and nothing else", () => {
    const lines = verdictLines(verdictsFor(audit));

    expect(lines[0]).toBe("sanitizer: PASS");
    expect(lines).toContain("reply-wanted: FAIL");
    expect(lines.at(-1)).toContain("reply-wanted 은 기준을 못 넘었습니다");
    expect(lines.at(-1)).not.toContain("sanitizer");
  });

  test("every gate clearing is said as such", () => {
    expect(verdictLines(verdictsFor({ ...audit, gates: [clears()] })).at(-1)).toContain("모두 기준을 넘었습니다");
  });
});

describe("a reading that judged no gate", () => {
  // What an audit pointed at a folder holding no frozen gate comes back with.
  const nothing = { folder: "/어딘가", seed: "씨앗", sample: 200, gates: [] };

  test("is not a reading that passed", () => {
    expect(judgedNothing(verdictsFor(nothing))).toBe(true);
    expect(judgedNothing(verdictsFor({ ...nothing, gates: [clears()] }))).toBe(false);
  });

  test("names no gate to build again, so the gates to rebuild cannot carry it", () => {
    expect(gatesToRebuild(verdictsFor(nothing))).toEqual([]);
  });

  test("says it judged nothing rather than that every bar was cleared", () => {
    const lines = verdictLines(verdictsFor(nothing));

    expect(lines.at(-1)).toContain("기준을 잰 게이트가 하나도 없습니다");
    expect(lines.at(-1)).not.toContain("넘었습니다");
  });
});

describe("the bars themselves", () => {
  test("are the specification's own five, and no sixth", () => {
    expect(bars).toEqual({ yield: 0.7, formatBreaks: 0.1, repeats: 0.05, answerDrift: 0.05, languageDrift: 0.05 });
  });

  test("the floors are the specification's own three", () => {
    expect(auditFloors).toEqual({ train: 4_000, minority: 1_000, evaluation: 1_000 });
  });
});
