import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  answersOf,
  balanceTolerance,
  candidateOf,
  datasetRowOf,
  gateSyntheses,
  gatesChosen,
  inTranscriptShape,
  languageBuckets,
  languageOf,
  readSynthBatch,
  roomKinds,
  stateText,
  synthesisFor,
  synthFloors,
  synthPrefix,
  synthSuffix,
  targetBalance,
  validateSynthRow,
} from "../../training/tooling/src/laya-synth";

import type { GateSynthesis, LanguageBucket, SynthAsk, SynthRow } from "../../training/tooling/src/laya-synth";
import type { Gold } from "../../training/tooling/src/laya-dataset";
import type { LayaQuestion } from "../../training/tooling/src/laya";
import { filled, promptText, promptTexts } from "../../training/tooling/src/prompts";
import { repositoryRoot } from "../../training/tooling/src/roots";
import { useToolingSettings } from "./settings";

useToolingSettings();

// One sentence of the writing prompt as the data file words it, filled as the prompt fills it.
function said(table: string, key: string, values: Readonly<Record<string, string | number>> = {}): string {
  return filled(promptText("laya-synth", table, key), values);
}

const shares = { calibration: 0.15, test: 0.15 };
const hangul = /[\uAC00-\uD7A3]/;

function gate(name: string): GateSynthesis {
  const found = synthesisFor(name);

  if (found === null) {
    throw new Error(`no gate ${name}`);
  }

  return found;
}

// A row is edited rather than written afresh in most of these, so each test names the one thing it
// broke and nothing else stands between the row and the refusal.
function copyOf(row: SynthRow): SynthRow {
  return JSON.parse(JSON.stringify(row)) as SynthRow;
}

function languageWanted(spec: GateSynthesis): LanguageBucket {
  return languageOf(stateText(spec, spec.example.state));
}

describe("the nine gates", () => {
  test("there are nine, each named once", () => {
    expect(gateSyntheses()).toHaveLength(9);
    expect(new Set(gateSyntheses().map((one) => one.gate)).size).toBe(9);
  });

  test("the nine gates each have a descriptor", () => {
    expect(gateSyntheses().map((one) => one.title)).toEqual([
      "System document classifier",
      "Room rule classifier",
      "Library knowledge classifier",
      "Situation rule matcher",
      "Note classifier",
      "Output format",
      "Sanitiser gate",
      "Person-book search",
      "Reply-or-not judge",
    ]);
  });

  // Every line a model reads is English: only the conversation stays in the rooms' words. Hangul stands in
  // the writer's prompt only inside a worked row's state and in the room record's own attachment markers and
  // a reply note's sender, which are the conversation as the rooms write it.
  test("every instruction and every question the writer is shown is English", () => {
    const conversation = new Set(["prompt.transcripts.attachments", "prompt.transcripts.room_note"]);

    for (const table of ["prompt", "prompt.transcripts", "prompt.batch", "prompt.languages", "prompt.rooms"]) {
      for (const [key, text] of Object.entries(promptTexts("laya-synth", table))) {
        if (!conversation.has(`${table}.${key}`)) {
          expect(`${table}.${key}: ${text}`).not.toMatch(hangul);
        }
      }
    }

    for (const spec of gateSyntheses()) {
      const words = [spec.title, spec.judges, spec.candidateWord ?? "", ...spec.questions.flatMap((one) => [one.instructions, ...Object.values(one.options ?? {})])];

      expect(words.filter((one) => hangul.test(one))).toEqual([]);

      for (const question of Object.values(spec.example.questions)) {
        // A candidate's line may name a person as the rooms write the name; the question before it may not.
        const declared = spec.questions.find((one) => question.instructions.startsWith(one.instructions));

        expect(declared).toBeDefined();
      }
    }
  });

  // The writer's questions are the ones the gates ask (`prompts/laya/questions.toml`), word for word, so a
  // checkpoint trained on the written rows has learnt what the gate asks. The sanitiser's rows are harvested
  // apart and its gate's question is its own.
  test("each question the writer is shown is the gate's own, word for word", () => {
    const asked = Bun.TOML.parse(readFileSync(join(repositoryRoot(), "prompts", "laya", "questions.toml"), "utf8")) as {
      fold: string;
      gates: Record<string, { question: string; subject: string }>;
      situation: { applies: string; spent: string; about: string };
    };

    for (const [name, one] of Object.entries(asked.gates)) {
      const spec = synthesisFor(name);

      if (spec !== null) {
        expect(spec.questions.map((question) => question.instructions)).toEqual([one.question]);
        expect(spec.candidateWord).toBe(one.subject);
      }
    }

    const situation = gate("situation-rules");

    expect(situation.questions.map((question) => question.instructions)).toEqual([asked.situation.applies, asked.situation.spent]);
    expect(asked.situation.about.startsWith(`${situation.candidateWord} {slug}: `)).toBe(true);
    expect(gate("output-format").questions[0]!.instructions).toBe(asked.fold);
  });

  test("no gate asks a score question", () => {
    for (const spec of gateSyntheses()) {
      for (const question of spec.questions) {
        expect(["noul", "choice"]).toContain(question.type);
      }
    }
  });

  test("a per-candidate gate declares its range and no other does", () => {
    for (const spec of gateSyntheses()) {
      expect(spec.candidates === null).toBe(!spec.perCandidate);
    }
  });

  test("every gate's language mix comes to one", () => {
    for (const spec of gateSyntheses()) {
      const total = languageBuckets.reduce((sum, bucket) => sum + spec.language[bucket], 0);

      expect(Math.abs(total - 1)).toBeLessThan(0.0001);
    }
  });

  test("only the asymmetric gates name a settleable answer", () => {
    const asymmetric = gateSyntheses()
      .filter((spec) => spec.questions.some((question) => question.safe !== undefined))
      .map((spec) => spec.gate);

    expect(asymmetric).toEqual(["sanitizer", "reply-wanted"]);
  });

  test("the reply-wanted gate settles only that the message was not for the chat agent", () => {
    const spec = gate("reply-wanted");

    expect(spec.questions).toHaveLength(1);
    expect(spec.questions[0]!.safe).toBe(false);
  });

  test("every gate's worked example passes its own validator", () => {
    for (const spec of gateSyntheses()) {
      const verdict = validateSynthRow(spec, spec.example, languageWanted(spec));

      expect({ gate: spec.gate, verdict }).toEqual({ gate: spec.gate, verdict: { ok: true } });
    }
  });

  test("the floors the specification fixes", () => {
    expect(synthFloors).toEqual({ train: 4_000, minority: 1_000, evaluation: 1_000 });
  });
});

describe("the balance target", () => {
  test("a yes/no question is drawn half and half", () => {
    expect(targetBalance(gate("sanitizer").questions[0]!)).toEqual({ true: 0.5, false: 0.5 });
  });

  test("a four-option choice is drawn a quarter each", () => {
    expect(targetBalance(gate("knowledge-classifier").questions[0]!)).toEqual({
      universal: 0.25,
      personal: 0.25,
      room: 0.25,
      none: 0.25,
    });
  });

  test("the tolerance leaves the minority floor reachable", () => {
    expect((0.5 - balanceTolerance) * synthFloors.train).toBeGreaterThanOrEqual(synthFloors.minority);
  });

  test("a yes/no question's answers are true and false", () => {
    expect(answersOf(gate("sanitizer").questions[0]!)).toEqual(["true", "false"]);
  });
});

describe("which language a row is written in", () => {
  test("text with no Hangul in it is English", () => {
    expect(languageOf("the unit came back up after the headers were installed")).toBe("english");
  });

  test("Korean prose carrying a path and an identifier is Korean", () => {
    expect(languageOf("\uC720\uB2DB\uC740 \uB2E4\uC2DC \uC130\uC5B4\uC694. laya-server/install.sh \uB97C \uB3CC\uB9AC\uBA74 \uB429\uB2C8\uB2E4.")).toBe("korean");
  });

  test("two lines of English prose inside Korean is mixed", () => {
    expect(languageOf([
      "\uB85C\uADF8\uB97C \uBD99\uC77C\uAC8C\uC694.",
      "Traceback most recent call last raised here",
      "RuntimeError failed to find the compiler on this host",
      "\uD5E4\uB354\uAC00 \uBE60\uC838 \uC788\uC5C8\uC2B5\uB2C8\uB2E4.",
    ].join("\n"))).toBe("mixed");
  });

  test("one English line among three is mixed, among many is not", () => {
    expect(languageOf("\uC9E7\uC740 \uB9D0\nthe build finished without an error\n\uB610 \uD55C \uB9C8\uB514")).toBe("mixed");
    expect(languageOf([
      "\uD55C \uC904",
      "\uB450 \uC904",
      "\uC138 \uC904",
      "\uB124 \uC904",
      "\uB2E4\uC12F \uC904",
      "\uC5EC\uC12F \uC904",
      "\uC77C\uACF1 \uC904",
      "the build finished without an error",
    ].join("\n"))).toBe("korean");
  });

  test("the text a language is read off leaves the machinery fields out", () => {
    const spec = gate("reply-wanted");
    const text = stateText(spec, spec.example.state);

    expect(text).not.toContain("group");
    expect(text).toContain("\uC774\uBC88 \uC8FC \uB2F9\uBC88 \uB204\uAD6C\uC9C0");
  });

  test("a transcript is read by what was said, not by who said it", () => {
    const spec = gate("reply-wanted");
    const text = stateText(spec, spec.example.state);

    // The sender's name, number and time are the line's shape rather than anybody's prose. Left in,
    // a Korean name would make an English message read as Korean and the row would be unwritable.
    expect(text).not.toContain("\uC138\uC601");
    expect(text).not.toContain("id 3391044");
    expect(text).not.toContain("2026-06-19");
  });

  test("an English message in a room of Korean names reads as English", () => {
    const spec = gate("reply-wanted");
    const state = {
      room: "group",
      recent: ["[2026-06-19T08:12:41.000Z] #1 \uC138\uC601 (id 3391044): could you take a look at the deploy log"],
      message: "[2026-06-19T08:13:20.000Z] #2 \uC900\uD638 (id 7712045): the build finished without an error",
    };

    expect(languageOf(stateText(spec, state))).toBe("english");
  });
});

describe("the transcript shapes", () => {
  test("the plain shape reads and the room shape does not stand in for it", () => {
    expect(inTranscriptShape("plain", "Member (id 4471902): \uC548\uB155")).toBe(true);
    expect(inTranscriptShape("plain", "[2026-01-01T00:00:00.000Z] #1 Member (id 4471902): \uC548\uB155")).toBe(false);
  });

  test("the room shape reads, with and without the owner tag", () => {
    expect(inTranscriptShape("room", "[2026-01-01T00:00:00.000Z] #1 Owner (id 10000001, OWNER): \uC548\uB155")).toBe(true);
    expect(inTranscriptShape("room", "[2026-01-01T00:00:00.000Z] #2 Member (id 4471902): \uC548\uB155")).toBe(true);
  });

  test("a message carrying its own newline still reads as its shape", () => {
    expect(inTranscriptShape("plain", "Member (id 4471902): \uCCAB \uC904\n\uB458\uC9F8 \uC904\nOwner (id 10000001): \uC751")).toBe(true);
  });

  test("one long message reads as its shape, however many lines it runs to", () => {
    expect(inTranscriptShape("plain", "Member (id 4471902): \uCCAB \uC904\n\uB458\uC9F8 \uC904\n\uC14B\uC9F8 \uC904\n\uB137\uC9F8 \uC904")).toBe(true);
  });

  test("a message numbered from below reads, since the archive holds such numbers", () => {
    expect(inTranscriptShape("room", "[2026-09-01T02:55:43.000Z] #-998950394 Owner (id 10000001, OWNER): /start")).toBe(true);
  });

  test("prose that opens with no sender at all does not", () => {
    expect(inTranscriptShape("plain", "\uCCAB \uC904\nMember (id 4471902): \uB458\uC9F8 \uC904")).toBe(false);
    expect(inTranscriptShape("room", "\uC624\uB298 \uC800\uB141 \uBB50 \uBA39\uC9C0")).toBe(false);
  });

  test("an unknown sender number is allowed", () => {
    expect(inTranscriptShape("plain", "\uC774\uB984 \uC5C6\uB294 \uC0AC\uB78C (id unknown): \uC548\uB155")).toBe(true);
  });

  test("a quiet instruction the bot was handed is an entry of the plain shape, and of no other", () => {
    expect(inTranscriptShape("plain", "quiet instruction from the bot: [\uC791\uC5C5 \uC2E4\uD589 \uC0C1\uD0DC]\n{\"state\":\"job-ended\"}")).toBe(true);
    expect(inTranscriptShape("room", "quiet instruction from the bot: [\uC791\uC5C5 \uC2E4\uD589 \uC0C1\uD0DC]")).toBe(false);
  });
});

describe("naming a per-candidate question", () => {
  test("one question a candidate is named by the slug alone", () => {
    expect(candidateOf(gate("system-documents"), "structure")).toEqual({ slug: "structure", id: "needed" });
  });

  test("two questions a candidate are named slug and question", () => {
    expect(candidateOf(gate("situation-rules"), "grocery-ping:spent")).toEqual({ slug: "grocery-ping", id: "spent" });
  });

  test("a slug that is not slug-shaped is not a candidate", () => {
    expect(candidateOf(gate("system-documents"), "Structure Doc")).toBeNull();
  });

  test("a gate that asks of the whole state names no candidate", () => {
    expect(candidateOf(gate("sanitizer"), "harmful")).toBeNull();
  });
});

describe("the validator refuses", () => {
  const classifier = gate("system-documents");
  const sanitizer = gate("sanitizer");
  const notes = gate("knowledge-classifier");

  test("a state with no text in it — empty-state", () => {
    const row = copyOf(sanitizer.example);

    row.state = "   ";

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "empty-state" });
  });

  test("a row that asks nothing — no-questions", () => {
    const row = copyOf(sanitizer.example);

    row.questions = {};
    row.gold = {};

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "no-questions" });
  });

  test("a question with no gold beside it — unanswered-question", () => {
    const row = copyOf(sanitizer.example);

    row.gold = {};

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "unanswered-question" });
  });

  test("a gold answering a question the row never asked — unasked-gold", () => {
    const row = copyOf(sanitizer.example);

    row.gold.invented = { type: "noul", label: "true", noul: 1, probabilities: { true: 1, false: 0 } };

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "unasked-gold" });
  });

  // A model leaves a question or a gold half-written now and then, and a row like that is a bad
  // row. The gate refuses it and carries on; it does not fall over, which would cost the whole
  // gate its run over one row the model fumbled.
  test("a question that is not a question at all — wrong-question-type", () => {
    const row = copyOf(sanitizer.example);

    row.questions.harmful = "\uBB3B\uB294 \uB9D0" as unknown as LayaQuestion;

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "wrong-question-type" });
  });

  test("a question with nothing written in its instructions — wrong-instructions", () => {
    const row = copyOf(sanitizer.example);

    row.questions.harmful = { type: "noul" } as unknown as LayaQuestion;

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "wrong-instructions" });
  });

  test("a gold with no probabilities in it — bad-probabilities", () => {
    const row = copyOf(sanitizer.example);

    row.gold.harmful = { type: "noul", label: "true", noul: 1 } as unknown as Gold;

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "bad-probabilities" });
  });

  test("a gold that is not an object at all — bad-probabilities", () => {
    const row = copyOf(sanitizer.example);

    row.gold.harmful = "\uCC38" as unknown as Gold;

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "bad-probabilities" });
  });

  test("a question of a type this gate does not ask — wrong-question-type", () => {
    const row = copyOf(sanitizer.example);

    row.questions.harmful = { type: "choice", instructions: row.questions.harmful!.instructions, criteria: { yes: "", no: "" } };

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "wrong-question-type" });
  });

  test("a question that does not ask what the gate asks — wrong-instructions", () => {
    const row = copyOf(sanitizer.example);

    row.questions.harmful = { type: "noul", instructions: "\uC774 \uAE00\uC740 \uC704\uD5D8\uD55C\uAC00?" };

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "wrong-instructions" });
  });

  test("a per-candidate question named something that is not a slug — bad-question-id", () => {
    const row = copyOf(classifier.example);
    const asked = row.questions.structure!;
    const gold = row.gold.structure!;

    delete row.questions.structure;
    delete row.gold.structure;
    row.questions["Structure Doc"] = asked;
    row.gold["Structure Doc"] = gold;

    expect(validateSynthRow(classifier, row, "korean")).toMatchObject({ ok: false, refusal: "bad-question-id" });
  });

  test("a candidate missing one of its two questions — bad-question-id", () => {
    const rules = gate("situation-rules");
    const row = copyOf(rules.example);

    delete row.questions["photo-thanks:spent"];
    delete row.gold["photo-thanks:spent"];

    expect(validateSynthRow(rules, row, "korean")).toMatchObject({ ok: false, refusal: "bad-question-id" });
  });

  test("fewer candidates than the gate offers — candidate-count", () => {
    const rules = gate("situation-rules");
    const row = copyOf(rules.example);
    const first = candidateOf(rules, Object.keys(row.questions)[0]!)!.slug;

    for (const id of Object.keys(row.questions).filter((one) => candidateOf(rules, one)!.slug !== first)) {
      delete row.questions[id];
      delete row.gold[id];
    }

    expect(1).toBeLessThan(rules.candidates!.min);
    expect(validateSynthRow(rules, row, "korean")).toMatchObject({ ok: false, refusal: "candidate-count" });
  });

  test("a gold naming answers the question does not have — bad-answers", () => {
    const row = copyOf(notes.example);

    row.gold.scope = { type: "choice", label: "personal", probabilities: { personal: 0.7, other: 0.3 } };

    expect(validateSynthRow(notes, row, "korean")).toMatchObject({ ok: false, refusal: "bad-answers" });
  });

  test("probabilities that do not come to one — bad-probabilities", () => {
    const row = copyOf(sanitizer.example);

    row.gold.harmful = { type: "noul", label: "false", noul: 0.3, probabilities: { true: 0.3, false: 0.3 } };

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "bad-probabilities" });
  });

  test("a label that is not the likeliest answer — bad-probabilities", () => {
    const row = copyOf(sanitizer.example);

    row.gold.harmful = { type: "noul", label: "true", noul: 0.2, probabilities: { true: 0.2, false: 0.8 } };

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "bad-probabilities" });
  });

  test("a transcript written in a shape the gate is not given — wrong-transcript", () => {
    const row = copyOf(classifier.example);

    row.state = "[2026-01-01T00:00:00.000Z] #1 Member (id 4471902): Robin \uC6CC\uCEE4\uAC00 \uC7A1\uC744 \uC5B4\uB514\uC11C \uBC1B\uC544\uC624\uB294\uC9C0 \uC54C\uC544?";

    expect(validateSynthRow(classifier, row, "korean")).toMatchObject({ ok: false, refusal: "wrong-transcript" });
  });

  test("a room-shaped gate handed plain lines — wrong-transcript", () => {
    const replies = gate("reply-wanted");
    const row = copyOf(replies.example);
    const state = row.state as { recent: string[]; message: string };

    state.message = "\uC138\uC601 (id 3391044): \uC544 \uB9DE\uB2E4 \uACE0\uB9C8\uC6CC";

    expect(validateSynthRow(replies, row, "korean")).toMatchObject({ ok: false, refusal: "wrong-transcript" });
  });

  test("a state field carrying a word the gate did not offer — bad-state-field", () => {
    const replies = gate("reply-wanted");
    const row = copyOf(replies.example);

    (row.state as { room: string }).room = "dm";

    expect(validateSynthRow(replies, row, "korean")).toMatchObject({ ok: false, refusal: "bad-state-field" });
  });

  test("a state field missing altogether — bad-state-field", () => {
    const replies = gate("reply-wanted");
    const row = copyOf(replies.example);

    delete (row.state as { room?: string }).room;

    expect(validateSynthRow(replies, row, "korean")).toMatchObject({ ok: false, refusal: "bad-state-field" });
  });

  test("a row in a language the batch did not ask for — wrong-language", () => {
    expect(validateSynthRow(sanitizer, sanitizer.example, "english")).toMatchObject({
      ok: false,
      refusal: "wrong-language",
    });
  });

  test("a row past what one Laya call reads — too-large", () => {
    const row = copyOf(sanitizer.example);

    row.state = `${"\uC774 \uAE00\uC740 \uC544\uC8FC \uAE41\uB2C8\uB2E4. ".repeat(200)}`;

    expect(validateSynthRow(sanitizer, row, "korean")).toMatchObject({ ok: false, refusal: "too-large" });
  });

  test("and lets a good row through", () => {
    expect(validateSynthRow(sanitizer, sanitizer.example, "korean")).toEqual({ ok: true });
  });
});

describe("the row as the training file holds it", () => {
  const spec = gate("sanitizer");

  test("the three parts go in as JSON strings under the gate's own name", () => {
    const row = datasetRowOf(spec, spec.example, shares);

    expect(row.gate).toBe("sanitizer");
    expect(row.id.startsWith("sanitizer:")).toBe(true);
    expect(JSON.parse(row.state)).toEqual(spec.example.state);
    expect(JSON.parse(row.questions)).toEqual(spec.example.questions);
    expect(JSON.parse(row.gold)).toEqual(spec.example.gold);
  });

  test("the same input gives the same id and the same split every time", () => {
    const once = datasetRowOf(spec, spec.example, shares);
    const twice = datasetRowOf(spec, copyOf(spec.example), shares);

    expect(twice.id).toBe(once.id);
    expect(twice.split).toBe(once.split);
  });

  test("a different input gives a different id", () => {
    const other = copyOf(spec.example);

    other.state = "\uB2E4\uB978 \uAE00\uC785\uB2C8\uB2E4. \uB77C\uC6B0\uD130 \uC124\uC815\uC744 \uBC31\uC5C5\uD574 \uB450\uB824\uACE0 \uD569\uB2C8\uB2E4.";

    expect(datasetRowOf(spec, other, shares).id).not.toBe(datasetRowOf(spec, spec.example, shares).id);
  });

  test("a split is one of the three", () => {
    for (const one of gateSyntheses()) {
      expect(["train", "calibration", "test"]).toContain(datasetRowOf(one, one.example, shares).split);
    }
  });
});

describe("the prompt", () => {
  const spec = gate("system-documents");

  test("the prefix carries the gate's rules, its line shape and its worked example", () => {
    const prefix = synthPrefix(spec);

    expect(prefix).toContain(spec.title);
    expect(prefix).toContain(spec.questions[0]!.instructions);
    expect(prefix).toContain(said("prompt.transcripts", "plain_line"));
    expect(prefix).toContain(said("prompt.transcripts", "attachments"));
    expect(prefix).toContain(JSON.stringify(spec.example));
  });

  test("the prefix does not move when the batch does, so a session can cache it", () => {
    const first: SynthAsk = { gate: spec.gate, count: 20, language: "korean", lean: true, room: "group", edge: false, seed: "a1" };
    const second: SynthAsk = { gate: spec.gate, count: 12, language: "mixed", lean: null, room: "ai", edge: true, seed: "b2" };

    expect(synthPrefix(spec)).toBe(synthPrefix(spec));
    expect(synthSuffix(spec, first)).not.toBe(synthSuffix(spec, second));
  });

  test("the suffix carries the count, the language, the room, the lean and the seed", () => {
    const suffix = synthSuffix(spec, { gate: spec.gate, count: 24, language: "mixed", lean: false, room: "ai", edge: true, seed: "zz9" });

    expect(suffix).toContain(said("prompt.batch", "count", { count: 24 }));
    expect(suffix).toContain(said("prompt.languages", "mixed"));
    expect(suffix).toContain(said("prompt.rooms", "ai"));
    expect(suffix).toContain(said("prompt.batch", "lean", { lean: "false" }));
    expect(suffix).toContain(said("prompt.batch", "edge"));
    expect(suffix).toContain("zz9");
  });

  test("a gate with a fixed word in its state says which words it takes", () => {
    const prefix = synthPrefix(gate("reply-wanted"));

    expect(prefix).toContain("`room`");
    expect(prefix).toContain("`owner`");
    expect(prefix).toContain("`group`");
  });

  test("a gate that says what its fields hold puts each of them in the prefix", () => {
    const described = { ...gate("reply-wanted"), fields: { message: "The chat agent's answer does not go here." }, stateChars: { least: 1_200, most: 1_700 } };
    const prefix = synthPrefix(described);

    expect(prefix).toContain(said("prompt", "fields"));
    expect(prefix).toContain("The chat agent's answer does not go here.");
    expect(prefix).toContain(said("prompt", "one_call_range", { least: 1_200, most: 1_700 }));
    expect(synthPrefix(gate("sanitizer"))).not.toContain(said("prompt", "fields"));
    expect(synthPrefix(gate("sanitizer"))).toContain(said("prompt", "one_call", { most: 700 }));
  });

  test("an asymmetric gate's prefix says which answer Laya may settle", () => {
    expect(synthPrefix(gate("reply-wanted"))).toContain(said("prompt", "asymmetric", { safe: "false" }));
  });

  test("a prefix is written for every gate and every room kind is described", () => {
    for (const one of gateSyntheses()) {
      expect(synthPrefix(one).length).toBeGreaterThan(200);
    }

    for (const room of roomKinds) {
      const suffix = synthSuffix(spec, { gate: spec.gate, count: 1, language: "korean", lean: null, room, edge: false, seed: "s" });

      expect(suffix).toContain(said("prompt.rooms", room));
    }
  });
});

describe("reading a batch back", () => {
  test("rows come back out of a fenced array", () => {
    const written = JSON.stringify([gate("sanitizer").example]);
    const reading = readSynthBatch(`\uC5EC\uAE30 \uC788\uC2B5\uB2C8\uB2E4.\n\`\`\`json\n${written}\n\`\`\``);

    expect(reading.rows).toHaveLength(1);
    expect(reading.unreadable).toBe(0);
  });

  test("an entry missing one of its three parts is counted unreadable", () => {
    const reading = readSynthBatch(JSON.stringify([{ state: "\uC548\uB155", questions: {} }, { state: "\uC548\uB155", questions: {}, gold: {} }]));

    expect(reading.unreadable).toBe(1);
    expect(reading.rows).toHaveLength(1);
  });

  test("an answer with no array in it reads as nothing", () => {
    expect(readSynthBatch("\uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4")).toEqual({ rows: [], unreadable: 0, readable: false, salvaged: false });
  });

  test("what comes back can be validated and frozen", () => {
    const spec = gate("knowledge-classifier");
    const reading = readSynthBatch(JSON.stringify([spec.example]));
    const row = reading.rows[0]!;

    expect(validateSynthRow(spec, row, languageWanted(spec))).toEqual({ ok: true });
    expect(datasetRowOf(spec, row, shares).gate).toBe("knowledge-classifier");
  });
});

describe("the gold a choice question carries", () => {
  test("every option of the note classifier is answerable", () => {
    const spec = gate("knowledge-classifier");

    for (const option of answersOf(spec.questions[0]!)) {
      const row = copyOf(spec.example);
      const probabilities: Record<string, number> = { universal: 0.1, personal: 0.1, room: 0.1, none: 0.1 };

      probabilities[option] = 0.7;
      row.gold.scope = { type: "choice", label: option, probabilities } as Gold;

      expect(validateSynthRow(spec, row, languageWanted(spec))).toEqual({ ok: true });
    }
  });
});

describe("which gates a run writes", () => {
  const namesOf = (chosen: ReturnType<typeof gatesChosen>): string[] =>
    typeof chosen === "string" ? [chosen] : chosen.map((one) => one.gate);

  test("nothing chosen and nothing left out is every gate this driver writes", () => {
    expect(namesOf(gatesChosen([], []))).toEqual(gateSyntheses().filter((one) => one.builtApart !== true).map((one) => one.gate));
  });

  test("a gate built apart is left out of the default roster", () => {
    expect(namesOf(gatesChosen([], []))).not.toContain("sanitizer");
  });

  test("a gate left out is every other gate this driver writes, in the roster order", () => {
    const kept = namesOf(gatesChosen([], ["room-rules"]));

    expect(kept).not.toContain("room-rules");
    expect(kept).toEqual(gateSyntheses().filter((one) => one.builtApart !== true && one.gate !== "room-rules").map((one) => one.gate));
  });

  test("a gate built apart, chosen outright, is turned back to where it is built", () => {
    expect(namesOf(gatesChosen(["sanitizer"], []))[0]).toContain("built by its own harvest");
  });

  test("an ordinary gate chosen outright is the only one written", () => {
    expect(namesOf(gatesChosen(["room-rules"], []))).toEqual(["room-rules"]);
  });

  test("what is left out is left out of what was chosen too", () => {
    expect(namesOf(gatesChosen(["sanitizer", "room-rules"], ["sanitizer"]))).toEqual(["room-rules"]);
  });

  test("a name that is no gate is said back, whichever side it was given on", () => {
    for (const chosen of [gatesChosen(["sanitiser"], []), gatesChosen([], ["sanitiser"])]) {
      expect(chosen).toContain("sanitiser");
      expect(chosen).toContain("sanitizer");
    }
  });

  test("leaving every gate out is refused rather than run as a run of nothing", () => {
    expect(gatesChosen([], gateSyntheses().map((one) => one.gate))).toContain("No gate is left");
  });
});
