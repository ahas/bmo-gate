// What the Laya checkpoint reads of one call, and whether a row fits inside it. Only the reach is
// here: this repository writes rows for the filter to be trained on and asks it only to measure a
// checkpoint (docs/reference-data.md, 「The figures」), so the client, the modes, the τ comparison and the verdict
// record are BMO's and stay there.

export type LayaState = string | Record<string, unknown> | readonly unknown[];

export type LayaQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string | null>> | readonly string[] }
  | { type: "score"; instructions: string; criteria: readonly string[] };

export interface LayaRequest {
  state: LayaState;
  questions: Readonly<Record<string, LayaQuestion>>;
}

// What one question may carry: the checkpoint reads 1,024 tokens per question, 256 of them kept for
// the question and its options, so the state has the rest.
export const layaMaxTokens = 1_024;
export const layaQuestionTokens = 256;
// The most questions the server takes in one call.
export const layaQuestionsPerCall = 128;

// The request as the calls BMO's client carries it in: its questions in their order, as many to a
// call as the server takes, each call with the whole state (docs/laya-gates.md, 「Question types」).
export function layaRequestParts(request: LayaRequest): LayaRequest[] {
  const entries = Object.entries(request.questions);
  const parts: LayaRequest[] = [];

  for (let at = 0; at < entries.length; at += layaQuestionsPerCall) {
    parts.push({ state: request.state, questions: Object.fromEntries(entries.slice(at, at + layaQuestionsPerCall)) });
  }

  return parts;
}

// A generous count of what the checkpoint's tokenizer makes of a text: a character outside ASCII
// (Hangul, mostly) as one token, and about three ASCII characters to a token.
export function layaEstimatedTokens(text: string): number {
  let ascii = 0;
  let other = 0;

  for (const char of text) {
    if (char.charCodeAt(0) < 128) {
      ascii += 1;
    } else {
      other += 1;
    }
  }

  return Math.ceil(other + ascii * 0.35);
}

function stateText(state: LayaState): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

// Whether a request fits the checkpoint: the state beside each question, and the question with its
// options inside the part kept for them. Laya would cut a state that runs over without saying so,
// and a verdict on half an input is not one worth recording as Laya's.
export function layaFits(request: LayaRequest): boolean {
  const stateTokens = layaEstimatedTokens(stateText(request.state));

  if (stateTokens > layaMaxTokens - layaQuestionTokens) {
    return false;
  }

  return Object.values(request.questions).every((question) => {
    const criteria = "criteria" in question ? JSON.stringify(question.criteria) : "";

    return layaEstimatedTokens(question.instructions + criteria) <= layaQuestionTokens;
  });
}
