import { statSync, readFileSync } from "node:fs";

import { batchPrompts, noTokens } from "./laya-synth-run";
import { dataPath } from "./roots";
import { settingText } from "./settings";

import type { JudgeRoad } from "./gate-judge";
import type { SynthAnswer, SynthAsker, TokenTally } from "./laya-synth-run";

// A fourth road for the sanitiser gate, whose rows codex refuses at the account level: the text model,
// the general text model the deployment runs itself, reached as one OpenAI-compatible front (the text
// model engine's own documents). It is not claude, and being uncensored it writes the gate's attack rows
// without flinching — the same reason the local-model road was chosen — and it is the road the owner
// names for this data.
//
// The road holds no session and reads no cache: one chat completion carries the gate's whole prefix
// afresh and the answer comes back as text, so nothing here resumes a thread. That is why a gate on
// this road is a run of independent batches rather than one held conversation.

// The answer slot and the wait. A batch is a long answer — twenty rows, each with its state and its
// sanitised text, not a one-line verdict — and an answer cut off mid-list holds no rows at all, so the
// slot is sized well past what one batch needs.
export const textEffort = "none";
export const textAnswerTokens = 16_384;

// The front's engine borrows cards that Laya's training passes take too, so it answers 503 while
// another service holds one of them, and 503 at once while it is set aside for a user that holds its
// cards for days. The per-call wait lets the whole answer slot be written after a long prompt read at
// a few hundred tokens a second (the text model engine's own documents).
export const textTimeoutMs = 3_000_000;


// A 503 means the shared card is busy elsewhere, not that the batch is bad. The road waits and asks
// again a bounded number of times before it gives up and stops the gate, which the unit then resumes.
// A 503 that says the engine is set aside is final: it stands for days, so the road stops at once
// with the front's own reason and the time it lapses at (the text model engine's own documents).
export const textBusyRetries = 5;
export const textBusyBackoffMs = 10_000;

// The model the road writes on, under the name the front lists it by, and the front's OpenAI base
// address: the tooling's settings `text_model` and `text_base_url` (docs/gate-data.md, 「The text model
// road」). A run reads them once as it starts, so a front moved to another model is followed by the
// next run with the settings changed and nothing else.
export function textModel(): string {
  return settingText("text_model");
}

export function textBaseUrl(): string {
  return settingText("text_base_url");
}

// The front's own service key, in the file the settings name as `text_key_file` under the data root's
// `env/`.
export function textKeyPath(): string {
  return dataPath("env", settingText("text_key_file"));
}

export type TextFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

// The front's own words where its 503 is an aside rather than a busy card, else null.
async function asideRefusal(response: Response): Promise<string | null> {
  try {
    const said: unknown = JSON.parse(await response.text());
    const error = typeof said === "object" && said !== null ? (said as { error?: { type?: unknown; message?: unknown } }).error : undefined;

    return error?.type === "set_aside" && typeof error.message === "string" ? error.message : null;
  } catch {
    return null;
  }
}

function setAside(reason: string): Error {
  return new Error(`the text model is set aside and does not answer: ${reason}`);
}

export interface TextSettings {
  baseUrl: string;
  model: string;
  answerTokens: number;
  timeoutMs: number;
  busyRetries: number;
  busyBackoffMs: number;
  // Read apart so the whole road can be driven without a key or a network in a test.
  readKey: () => string;
  fetch: TextFetch;
  // Handed in so a test does not sleep the backoff for real.
  wait: (ms: number) => Promise<void>;
}

// The key is the front's own service key. It must be exactly 0600 or it is treated as absent rather
// than trusted with loose permissions.
export function readTextKey(path: string = textKeyPath()): string {
  const stat = statSync(path);

  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size === 0) {
    throw new Error(`${path} is not 0600 or is empty, so it is not used as a key.`);
  }

  const key = readFileSync(path, "utf8").trim();

  if (key === "") {
    throw new Error(`${path} is empty.`);
  }

  return key;
}

function headers(key: string): Headers {
  return new Headers({
    authorization: `Bearer ${key}`,
    accept: "application/json",
    "content-type": "application/json",
  });
}

// The chat completion one batch is. The front serves one model, but the OpenAI shape names it, so
// the request carries the model, the two messages and the answer slot. The model is told not to
// think before it answers, since a batch of rows wants the whole slot for rows.
export function textBody(system: string, prompt: string, model: string, answerTokens: number): string {
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    max_tokens: answerTokens,
    temperature: 0.9,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  });
}

interface ChatCompletion {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function tokensOf(usage: ChatCompletion["usage"]): TokenTally {
  if (usage === undefined) {
    return noTokens;
  }

  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;

  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

// An answer the front returned with no text in it. The weak model behind this road now and then
// hands back an empty completion, which is a transient rather than a bad batch, so it is told apart
// from a malformed answer and waited out like a busy card.
export class TextEmptyAnswer extends Error {
  constructor() {
    super("the answer holds no text");
  }
}

// The text and the tokens out of one chat completion, or a thrown error naming what was wrong with
// the shape. A completion with no message text is raised as an empty answer, which the caller retries.
export function readTextAnswer(body: string): { text: string; tokens: TokenTally } {
  if (body.trim() === "") {
    throw new TextEmptyAnswer();
  }

  const value = JSON.parse(body) as ChatCompletion;
  const content = value.choices?.[0]?.message?.content;

  if (typeof content !== "string" || content.trim() === "") {
    throw new TextEmptyAnswer();
  }

  return { text: content, tokens: tokensOf(value.usage) };
}

// A road is always handed the model it writes on, the one the settings name (`textModel`), never a default.
export type TextRoadSettings = Partial<TextSettings> & Pick<TextSettings, "model">;

function withDefaults(settings: TextRoadSettings): TextSettings {
  return {
    baseUrl: settings.baseUrl ?? textBaseUrl(),
    model: settings.model,
    answerTokens: settings.answerTokens ?? textAnswerTokens,
    timeoutMs: settings.timeoutMs ?? textTimeoutMs,
    busyRetries: settings.busyRetries ?? textBusyRetries,
    busyBackoffMs: settings.busyBackoffMs ?? textBusyBackoffMs,
    readKey: settings.readKey ?? (() => readTextKey()),
    fetch: settings.fetch ?? ((input, init) => fetch(input, init)),
    wait: settings.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

// The one model the front serves must be the one the settings gave this road, so a front still serving
// another model, or one swapped out from under it, cannot label another model's rows as this one's.
// Checked once, since the list changes rarely and asking on every batch would double a gate's requests.
async function confirmModel(settings: TextSettings, key: string): Promise<void> {
  const response = await settings.fetch(`${settings.baseUrl}/models`, {
    headers: headers(key),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`the front answered its model list with ${response.status}`);
  }

  const listed = ((await response.json()) as { data?: { id?: unknown }[] }).data ?? [];
  const ids = listed.map((one) => one.id).filter((id): id is string => typeof id === "string");

  if (ids.length !== 1 || ids[0] !== settings.model) {
    throw new Error(`the front serves ${ids.join(", ") || "no model"} but the settings give this road ${settings.model}`);
  }
}

// One chat completion, retried while the shared card is busy. A 503 or a network fault waits the
// backoff and asks again up to the bound; any other non-ok status, or a body that will not read,
// fails at once. What comes back is the answer text and its token tally.
async function complete(settings: TextSettings, key: string, system: string, prompt: string): Promise<{ text: string; tokens: TokenTally }> {
  let lastBusy: unknown = null;

  for (let attempt = 0; attempt <= settings.busyRetries; attempt += 1) {
    let response: Response;

    try {
      response = await settings.fetch(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers(key),
        body: textBody(system, prompt, settings.model, settings.answerTokens),
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch (trouble) {
      // A network fault or a timeout is treated like a busy card: waited on and asked again.
      lastBusy = trouble;

      if (attempt < settings.busyRetries) {
        await settings.wait(settings.busyBackoffMs);
      }

      continue;
    }

    if (response.status === 503) {
      const aside = await asideRefusal(response);

      if (aside !== null) {
        throw setAside(aside);
      }

      lastBusy = new Error("the card is busy and answered 503");

      if (attempt < settings.busyRetries) {
        await settings.wait(settings.busyBackoffMs);
      }

      continue;
    }

    if (!response.ok) {
      throw new Error(`the text model front answered ${response.status}`);
    }

    try {
      return readTextAnswer(await response.text());
    } catch (trouble) {
      // An empty completion is a transient of the weak model, waited out like a busy card; a
      // malformed answer is a real fault and is raised at once.
      if (!(trouble instanceof TextEmptyAnswer)) {
        throw trouble;
      }

      lastBusy = trouble;

      if (attempt < settings.busyRetries) {
        await settings.wait(settings.busyBackoffMs);
      }
    }
  }

  throw new Error(`the text model front did not answer in ${settings.busyRetries + 1} tries: ${lastBusy instanceof Error ? lastBusy.message : String(lastBusy)}`);
}

// The judging road here: one batch of real rows in, one answer out, no session between them. A
// batch the front does not answer throws rather than coming back empty, the same contract the codex
// road keeps.
export function textJudgeRoad(settings: TextRoadSettings): JudgeRoad {
  const full = withDefaults(settings);
  let confirmed = false;

  return async (system, prompt) => {
    const key = full.readKey();

    if (!confirmed) {
      await confirmModel(full, key);
      confirmed = true;
    }

    const { text, tokens } = await complete(full, key, system, prompt);

    return { text, sessionId: null, tokens };
  };
}

// The asker `runSynthesis` drives on this road: one batch in, one answer out, no session between
// them. A batch the front does not answer throws rather than coming back empty, so the gate stops at
// that batch and is taken up again where it left off.
export function textAsker(settings: TextRoadSettings): SynthAsker {
  const full = withDefaults(settings);
  let confirmed = false;

  return async (spec, ask): Promise<SynthAnswer> => {
    const key = full.readKey();

    if (!confirmed) {
      await confirmModel(full, key);
      confirmed = true;
    }

    const { system, prompt } = batchPrompts(spec, ask);

    try {
      const { text, tokens } = await complete(full, key, system, prompt);

      return { text, sessionId: null, tokens };
    } catch (trouble) {
      throw new Error(`${spec.gate} ${ask.seed}: ${trouble instanceof Error ? trouble.message : String(trouble)}`);
    }
  };
}
