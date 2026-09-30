import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { batchPrompts, noTokens } from "./laya-synth-run";
import { dataRoot } from "./roots";

import type { JudgeRoad } from "./gate-judge";
import type { SynthAnswer, SynthAsker, TokenTally } from "./laya-synth-run";

// A fourth road for the sanitiser gate, whose rows codex refuses at the account level: the general
// text model on n5, reached through main-host's tunnel door as an OpenAI-compatible front
// (docs/n5-llm.md). It is not claude, and being uncensored it writes the gate's attack rows without
// flinching — the same reason J3090 was chosen — and it is the road 하스 names for this data.
//
// The road holds no session and reads no cache: one chat completion carries the gate's whole prefix
// afresh and the answer comes back as text, so nothing here resumes a thread. That is why a gate on
// this road is a run of independent batches rather than one held conversation.

// The one model the front serves, its answer slot, and its wait. A batch is a long answer — twenty
// rows, each with its state and its sanitised text, not a one-line verdict — and an answer cut off
// mid-list holds no rows at all, so the slot is sized well past what one batch needs.
export const n5Model = "RVN-Q4_K_M-multilingual-mtp";
export const n5Effort = "none";
export const n5AnswerTokens = 16_384;

// The front shares one card with the voice server and with Laya's training passes, so it answers
// 503 while another of them holds the card. The model writes about six tokens a second with part of
// it on the CPU (docs/n5-llm.md), so the per-call wait lets the whole answer slot be written.
export const n5TimeoutMs = 3_000_000;

// The base URL an OpenAI client is given on main-host, where the tunnel door lands the front.
export const n5BaseUrl = "http://127.0.0.1:18020/v1";

// A 503 means the shared card is busy elsewhere, not that the batch is bad. The road waits and asks
// again a bounded number of times before it gives up and stops the gate, which the unit then resumes.
export const n5BusyRetries = 5;
export const n5BusyBackoffMs = 10_000;

export type N5Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface N5Settings {
  baseUrl: string;
  model: string;
  answerTokens: number;
  timeoutMs: number;
  busyRetries: number;
  busyBackoffMs: number;
  // Read apart so the whole road can be driven without a key or a network in a test.
  readKey: () => string;
  fetch: N5Fetch;
  // Handed in so a test does not sleep the backoff for real.
  wait: (ms: number) => Promise<void>;
}

// Where the key lives, outside the archive and the checkout, and it must be exactly 0600 or it is
// treated as absent rather than trusted with loose permissions. It is the same file the front's own
// tunnel is dialled with (docs/n5-llm.md 「The key」).
export function n5KeyPath(): string {
  return join(dataRoot(), "env", "n5-llm.token");
}

export function readN5Key(path: string = n5KeyPath()): string {
  const stat = statSync(path);

  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size === 0) {
    throw new Error(`${path} 의 권한이 0600 이 아니거나 비어 있어 열쇠로 쓰지 않습니다.`);
  }

  const key = readFileSync(path, "utf8").trim();

  if (key === "") {
    throw new Error(`${path} 가 비어 있습니다.`);
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
export function n5Body(system: string, prompt: string, model: string, answerTokens: number): string {
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
export class N5EmptyAnswer extends Error {
  constructor() {
    super("답에 글이 없습니다.");
  }
}

// The text and the tokens out of one chat completion, or a thrown error naming what was wrong with
// the shape. A completion with no message text is raised as an empty answer, which the caller retries.
export function readN5Answer(body: string): { text: string; tokens: TokenTally } {
  if (body.trim() === "") {
    throw new N5EmptyAnswer();
  }

  const value = JSON.parse(body) as ChatCompletion;
  const content = value.choices?.[0]?.message?.content;

  if (typeof content !== "string" || content.trim() === "") {
    throw new N5EmptyAnswer();
  }

  return { text: content, tokens: tokensOf(value.usage) };
}

function withDefaults(settings: Partial<N5Settings>): N5Settings {
  return {
    baseUrl: settings.baseUrl ?? n5BaseUrl,
    model: settings.model ?? n5Model,
    answerTokens: settings.answerTokens ?? n5AnswerTokens,
    timeoutMs: settings.timeoutMs ?? n5TimeoutMs,
    busyRetries: settings.busyRetries ?? n5BusyRetries,
    busyBackoffMs: settings.busyBackoffMs ?? n5BusyBackoffMs,
    readKey: settings.readKey ?? (() => readN5Key()),
    fetch: settings.fetch ?? ((input, init) => fetch(input, init)),
    wait: settings.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

// The one model the front serves must be the one this road claims to write on, so a front that
// swapped its model out cannot label another model's rows as this one's. Checked once, since the
// list changes rarely and asking on every batch would double a gate's requests.
async function confirmModel(settings: N5Settings, key: string): Promise<void> {
  const response = await settings.fetch(`${settings.baseUrl}/models`, {
    headers: headers(key),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`모델 목록을 ${response.status} 로 받았습니다.`);
  }

  const listed = ((await response.json()) as { data?: { id?: unknown }[] }).data ?? [];
  const ids = listed.map((one) => one.id).filter((id): id is string => typeof id === "string");

  if (ids.length !== 1 || ids[0] !== settings.model) {
    throw new Error(`앞단이 서빙하는 모델은 ${ids.join(", ") || "없음"} 인데 이 길은 ${settings.model} 을 씁니다.`);
  }
}

// One chat completion, retried while the shared card is busy. A 503 or a network fault waits the
// backoff and asks again up to the bound; any other non-ok status, or a body that will not read,
// fails at once. What comes back is the answer text and its token tally.
async function complete(settings: N5Settings, key: string, system: string, prompt: string): Promise<{ text: string; tokens: TokenTally }> {
  let lastBusy: unknown = null;

  for (let attempt = 0; attempt <= settings.busyRetries; attempt += 1) {
    let response: Response;

    try {
      response = await settings.fetch(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers(key),
        body: n5Body(system, prompt, settings.model, settings.answerTokens),
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
      lastBusy = new Error("카드가 바빠 503 으로 답했습니다.");

      if (attempt < settings.busyRetries) {
        await settings.wait(settings.busyBackoffMs);
      }

      continue;
    }

    if (!response.ok) {
      throw new Error(`n5 가 ${response.status} 로 답했습니다.`);
    }

    try {
      return readN5Answer(await response.text());
    } catch (trouble) {
      // An empty completion is a transient of the weak model, waited out like a busy card; a
      // malformed answer is a real fault and is raised at once.
      if (!(trouble instanceof N5EmptyAnswer)) {
        throw trouble;
      }

      lastBusy = trouble;

      if (attempt < settings.busyRetries) {
        await settings.wait(settings.busyBackoffMs);
      }
    }
  }

  throw new Error(`n5 가 ${settings.busyRetries + 1}번 내내 답하지 못했습니다: ${lastBusy instanceof Error ? lastBusy.message : String(lastBusy)}`);
}

// The judging road here: one batch of real rows in, one answer out, no session between them. A
// batch the front does not answer throws rather than coming back empty, the same contract the codex
// road keeps.
export function n5JudgeRoad(settings: Partial<N5Settings> = {}): JudgeRoad {
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
export function n5Asker(settings: Partial<N5Settings> = {}): SynthAsker {
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
