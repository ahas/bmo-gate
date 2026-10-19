import { describe, expect, test } from "bun:test";

import { auditFloors } from "../../training/tooling/src/laya-audit";
import { bars, gatesToRebuild, judgedNothing, verdictFor, verdictLines, verdictsFor } from "../../training/tooling/src/gate-verdict";

import type { GateAudit, GenerationReading } from "../../training/tooling/src/laya-audit";
import { useToolingSettings } from "./settings";

useToolingSettings();

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
    expect(verdict.missed[0]).toMatchObject({ bar: "yield", got: 0.69, wanted: bars.yield, side: "at least" });
  });

  test("a yield exactly on the bar passes, because the bar is 'at least'", () => {
    expect(verdictFor(clears(wrote({ keptShare: bars.yield }))).passed).toBe(true);
  });

  test("format breaks over the bar fail and are named", () => {
    const verdict = verdictFor(clears(wrote({ formatBreakShare: 0.11 })));

    expect(verdict.missed).toHaveLength(1);
    expect(verdict.missed[0]).toMatchObject({ bar: "format breaks", got: 0.11, wanted: bars.formatBreaks, side: "at most" });
  });

  test("format breaks exactly on the bar pass, because the bar is 'at most'", () => {
    expect(verdictFor(clears(wrote({ formatBreakShare: bars.formatBreaks }))).passed).toBe(true);
  });

  test("repeats over the bar fail and are named", () => {
    const verdict = verdictFor(clears(wrote({ duplicateShare: 0.06 })));

    expect(verdict.missed).toHaveLength(1);
    expect(verdict.missed[0]).toMatchObject({ bar: "repeats", got: 0.06, wanted: bars.repeats });
  });

  test("answer drift over the bar fails and is named", () => {
    const verdict = verdictFor(clears({ balanceDrift: 0.08 }));

    expect(verdict.missed).toHaveLength(1);
    expect(verdict.missed[0]).toMatchObject({ bar: "answer balance", got: 0.08, wanted: bars.answerDrift });
  });

  test("language drift over the bar fails and is named", () => {
    const verdict = verdictFor(clears({ languageDrift: 0.2 }));

    expect(verdict.missed).toHaveLength(1);
    expect(verdict.missed[0]).toMatchObject({ bar: "language", got: 0.2, wanted: bars.languageDrift });
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
    expect(verdict.missed[0]).toMatchObject({ bar: "training rows floor", got: 3_999, wanted: auditFloors.train });
    expect(verdict.missed[0]!.said).toContain("1 rows short");
  });

  test("too few of the rarer answer fails on its own floor", () => {
    const verdict = verdictFor(clears({ floors: { train: 4_900, minority: 999, evaluation: 1_050, met: false } }));

    expect(verdict.missed.map((one) => one.bar)).toEqual(["rarer answer floor"]);
  });

  test("too few held out fails on its own floor", () => {
    const verdict = verdictFor(clears({ floors: { train: 4_900, minority: 3_430, evaluation: 999, met: false } }));

    expect(verdict.missed.map((one) => one.bar)).toEqual(["evaluation rows floor"]);
  });

  test("the three floors are named apart, since each is put right by something different", () => {
    const verdict = verdictFor(clears({ floors: { train: 1, minority: 1, evaluation: 1, met: false } }));

    expect(verdict.missed.map((one) => one.bar)).toEqual(["training rows floor", "rarer answer floor", "evaluation rows floor"]);
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
      "yield", "format breaks", "repeats", "answer balance", "language", "training rows floor", "rarer answer floor", "evaluation rows floor",
    ]);
  });
});

describe("a gate whose run left no meta", () => {
  test("does not pass, because three of the bars cannot be read at all", () => {
    const verdict = verdictFor(clears({ generation: null }));

    expect(verdict.passed).toBe(false);
    expect(verdict.missed[0]!.said).toContain("cannot be read");
  });

  test("the two read off the frozen sample are still judged", () => {
    const verdict = verdictFor(clears({ generation: null, languageDrift: 0.4 }));

    expect(verdict.missed.map((one) => one.bar)).toContain("language");
  });
});

describe("the verdict over a whole dataset", () => {
  const audit = {
    folder: "/somewhere",
    seed: "seed",
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
    expect(lines.at(-1)).toContain("reply-wanted did not clear the bars");
    expect(lines.at(-1)).not.toContain("sanitizer");
  });

  test("every gate clearing is said as such", () => {
    expect(verdictLines(verdictsFor({ ...audit, gates: [clears()] })).at(-1)).toContain("cleared the bars");
  });
});

describe("a reading that judged no gate", () => {
  // What an audit pointed at a folder holding no frozen gate comes back with.
  const nothing = { folder: "/somewhere", seed: "seed", sample: 200, gates: [] };

  test("is not a reading that passed", () => {
    expect(judgedNothing(verdictsFor(nothing))).toBe(true);
    expect(judgedNothing(verdictsFor({ ...nothing, gates: [clears()] }))).toBe(false);
  });

  test("names no gate to build again, so the gates to rebuild cannot carry it", () => {
    expect(gatesToRebuild(verdictsFor(nothing))).toEqual([]);
  });

  test("says it judged nothing rather than that every bar was cleared", () => {
    const lines = verdictLines(verdictsFor(nothing));

    expect(lines.at(-1)).toContain("No gate was measured against the bars");
    expect(lines.at(-1)).not.toContain("cleared");
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
