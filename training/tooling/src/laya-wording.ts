import { filled, promptFile } from "./prompts";
import { candidateOf, declaredFor, synthesisFor } from "./laya-synth";

import type { LayaQuestion } from "./laya";
import type { DatasetRow } from "./laya-dataset";
import type { GateSynthesis } from "./laya-synth";

// A row read in its gate's own wording (docs/gate-data.md, 「A question reworded」). A row asks a question
// in the words it was written with; where those are an earlier wording of the same question, listed for the
// gate in `prompts/tooling/laya-wordings.toml`, the row is read with the gate's own wording in their place,
// its candidate named by the gate's own word. Nothing here writes a file: the merge, the audit and a
// training pass's copy each read a row through this, and what stands on disk keeps its words.

interface EarlierWordings {
  questions: Readonly<Record<string, readonly string[]>>;
  candidateWords: readonly string[];
}

const none: EarlierWordings = { questions: {}, candidateWords: [] };

function texts(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((one) => typeof one !== "string" || one.trim() === "")) {
    throw new Error(`${where} in prompts/tooling/laya-wordings.toml is not a list of texts`);
  }

  return value.map((one: string) => filled(one));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The earlier wordings one gate's rows may ask, and the earlier words their candidates may be named by. */
export function earlierWordings(gate: string): EarlierWordings {
  const gates = promptFile("laya-wordings").gates;
  const said = isRecord(gates) ? gates[gate] : undefined;

  if (!isRecord(said)) {
    return none;
  }

  const questions = isRecord(said.questions) ? said.questions : {};

  return {
    questions: Object.fromEntries(Object.entries(questions).map(([id, one]) => [id, texts(one, `gates.${gate}.questions.${id}`)])),
    candidateWords: said.candidate_words === undefined ? [] : texts(said.candidate_words, `gates.${gate}.candidate_words`),
  };
}

// One question as the gate asks it now, or the question as it stands where it opens with no wording the
// gate knows: such a question asks something else, and the validator says so.
function questionNow(spec: GateSynthesis, earlier: EarlierWordings, id: string, question: LayaQuestion): LayaQuestion {
  const declared = declaredFor(spec, id);

  if (declared === null || !isRecord(question) || question.type !== declared.type || typeof question.instructions !== "string") {
    return question;
  }

  const wording = [declared.instructions, ...(earlier.questions[declared.id] ?? [])].find((one) => question.instructions.startsWith(one));

  if (wording === undefined) {
    return question;
  }

  let rest = question.instructions.slice(wording.length);
  const slug = candidateOf(spec, id)?.slug;

  // A candidate's part opens with the word it is named by and then its slug; the slug and its line stay
  // as written, since they come from the brain's English index whatever the question's wording was.
  if (spec.candidateWord !== undefined && slug !== undefined) {
    const word = [spec.candidateWord, ...earlier.candidateWords].find((one) => rest.startsWith(` ${one} ${slug}:`));

    if (word !== undefined) {
      rest = ` ${spec.candidateWord}${rest.slice(word.length + 1)}`;
    }
  }

  const instructions = `${declared.instructions}${rest}`;

  return declared.type === "choice" && declared.options !== undefined
    ? { type: "choice", instructions, criteria: declared.options }
    : { ...question, instructions };
}

/** A gate's questions as the gate asks them now, or null where every one already does. */
export function questionsNow(spec: GateSynthesis, questions: Readonly<Record<string, LayaQuestion>>): Record<string, LayaQuestion> | null {
  const earlier = earlierWordings(spec.gate);
  let moved = false;
  const now = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const asked = questionNow(spec, earlier, id, question);

    moved ||= JSON.stringify(asked) !== JSON.stringify(question);

    return [id, asked];
  }));

  return moved ? now : null;
}

/** A row asking its gate's own wording: the row itself where it already does, or where its gate is none the
 * tooling writes rows for or its questions cannot be read. Its id and split are the ones it was made with. */
export function askedNow<Row extends DatasetRow>(row: Row): Row {
  const spec = synthesisFor(row.gate);

  if (spec === null) {
    return row;
  }

  let questions: unknown;

  try {
    questions = JSON.parse(row.questions);
  } catch {
    return row;
  }

  if (!isRecord(questions)) {
    return row;
  }

  const now = questionsNow(spec, questions as Record<string, LayaQuestion>);

  return now === null ? row : { ...row, questions: JSON.stringify(now) };
}
