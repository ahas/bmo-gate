import { describe, expect, test } from "bun:test";

import { datasetRowOf, gateSyntheses, synthesisFor, validateSynthRow } from "../../training/tooling/src/laya-synth";
import { askedNow, earlierWordings } from "../../training/tooling/src/laya-wording";
import { promptFile } from "../../training/tooling/src/prompts";
import { useToolingSettings } from "./settings";

import type { LayaQuestion } from "../../training/tooling/src/laya";
import type { DatasetRow } from "../../training/tooling/src/laya-dataset";
import type { GateSynthesis, SynthRow } from "../../training/tooling/src/laya-synth";

useToolingSettings();

// A row read in its gate's own wording (docs/gate-data.md, 「A question reworded」).

const shares = { calibration: 0.15, test: 0.15 };

function gate(name: string): GateSynthesis {
  const found = synthesisFor(name);

  if (found === null) {
    throw new Error(`no gate ${name}`);
  }

  return found;
}

function rowOf(spec: GateSynthesis, questions: Record<string, LayaQuestion>): DatasetRow {
  return datasetRowOf(spec, { state: spec.example.state, questions, gold: spec.example.gold } as SynthRow, shares);
}

function questionsOf(row: DatasetRow): Record<string, LayaQuestion> {
  return JSON.parse(row.questions) as Record<string, LayaQuestion>;
}

// The gate's worked row with every question put back in the gate's first earlier wording, as a run started
// before the rewording wrote it.
function inEarlierWording(spec: GateSynthesis): Record<string, LayaQuestion> {
  const earlier = earlierWordings(spec.gate);

  return Object.fromEntries(Object.entries(spec.example.questions).map(([id, question]) => {
    const declared = spec.questions.find((one) => question.instructions.startsWith(one.instructions))!;
    let rest = question.instructions.slice(declared.instructions.length);

    if (spec.candidateWord !== undefined) {
      rest = rest.replace(` ${spec.candidateWord} `, ` ${earlier.candidateWords[0]!} `);
    }

    return [id, { ...question, instructions: `${earlier.questions[declared.id]![0]!}${rest}` }];
  }));
}

describe("the earlier wordings", () => {
  test("each is listed for a gate the tooling writes and a question that gate asks", () => {
    const gates = promptFile("laya-wordings").gates as Record<string, unknown>;

    for (const name of Object.keys(gates)) {
      const spec = gate(name);
      const earlier = earlierWordings(name);

      for (const [id, wordings] of Object.entries(earlier.questions)) {
        const declared = spec.questions.find((one) => one.id === id);

        expect(declared).toBeDefined();
        expect(wordings).not.toContain(declared!.instructions);
      }

      expect(earlier.candidateWords.length === 0 || spec.candidateWord !== undefined).toBe(true);
    }
  });

  test("every gate the tooling writes has its earlier wording listed", () => {
    for (const spec of gateSyntheses()) {
      expect(Object.keys(earlierWordings(spec.gate).questions).sort()).toEqual(spec.questions.map((one) => one.id).sort());
    }
  });

  test("an earlier wording is filled with the deployment's names as the gate's own is", () => {
    const wording = earlierWordings("reply-wanted").questions.forAgent![0]!;

    expect(wording).toContain("Robin");
    expect(wording).not.toContain("{{");
  });
});

describe("a row read in its gate's own wording", () => {
  test("a question asked of the whole input reads the gate's own", () => {
    for (const name of ["output-format", "reply-wanted"]) {
      const spec = gate(name);

      expect(questionsOf(askedNow(rowOf(spec, inEarlierWording(spec))))).toEqual(spec.example.questions);
    }
  });

  test("a choice question carries the gate's own options, whatever its own were called", () => {
    const notes = gate("knowledge-classifier");
    const written = inEarlierWording(notes) as Record<string, { type: string; instructions: string; critria?: unknown }>;

    written.scope = { type: "choice", instructions: written.scope!.instructions, critria: { personal: "" } };

    const now = questionsOf(askedNow(rowOf(notes, written as unknown as Record<string, LayaQuestion>)));

    expect(now.scope).toEqual({ type: "choice", instructions: notes.questions[0]!.instructions, criteria: notes.questions[0]!.options! });
  });

  test("a row already asking the gate's own wording is the row itself", () => {
    for (const spec of gateSyntheses()) {
      const row = rowOf(spec, spec.example.questions);

      expect(askedNow(row)).toBe(row);
    }
  });

  test("a gate the tooling writes no rows for, or questions that cannot be read, stay as they are", () => {
    const folds = gate("output-format");
    const other = { ...rowOf(folds, inEarlierWording(folds)), gate: "session-summary" };
    const broken = { ...rowOf(folds, folds.example.questions), questions: "{not json" };

    expect(askedNow(other)).toBe(other);
    expect(askedNow(broken)).toBe(broken);
  });
});
