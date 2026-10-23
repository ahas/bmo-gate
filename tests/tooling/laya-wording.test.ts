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
  test("a candidate's question in the earlier wording asks the gate's own, its slug and line as written", () => {
    const rules = gate("room-rules");
    const earlier = rowOf(rules, inEarlierWording(rules));

    expect(Object.values(questionsOf(earlier)).some((one) => one.instructions.startsWith(rules.questions[0]!.instructions))).toBe(false);

    const now = askedNow(earlier);

    expect(questionsOf(now)).toEqual(rules.example.questions);
    expect({ ...now, questions: "" }).toEqual({ ...earlier, questions: "" });
  });

  test("a gate asking two questions of each candidate reads both", () => {
    const situation = gate("situation-rules");
    const now = askedNow(rowOf(situation, inEarlierWording(situation)));

    expect(questionsOf(now)).toEqual(situation.example.questions);
    expect(validateSynthRow(situation, { state: situation.example.state, questions: questionsOf(now), gold: situation.example.gold }, "korean"))
      .toEqual({ ok: true });
  });

  test("a question asked of the whole input reads the gate's own", () => {
    for (const name of ["output-format", "reply-wanted", "sanitizer"]) {
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

  test("a wording the list does not hold is left as written, and the validator refuses it", () => {
    const rules = gate("room-rules");
    const written = { "photo-consent": { type: "noul" as const, instructions: "Does this rule bear on the room? Rule photo-consent: a photo" } };
    const row = rowOf(rules, written);

    expect(askedNow(row)).toBe(row);
    expect(validateSynthRow(rules, { state: rules.example.state, questions: written, gold: { "photo-consent": rules.example.gold["photo-consent"]! } }, "korean"))
      .toMatchObject({ ok: false, refusal: "wrong-instructions" });
  });

  test("a gate the tooling writes no rows for, or questions that cannot be read, stay as they are", () => {
    const rules = gate("room-rules");
    const other = { ...rowOf(rules, inEarlierWording(rules)), gate: "room-memories" };
    const broken = { ...rowOf(rules, rules.example.questions), questions: "{not json" };

    expect(askedNow(other)).toBe(other);
    expect(askedNow(broken)).toBe(broken);
  });
});
