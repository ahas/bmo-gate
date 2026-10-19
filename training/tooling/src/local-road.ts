import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createParser } from "eventsource-parser";

import { batchPrompts, noTokens } from "./laya-synth-run";
import { dataRoot } from "./roots";
import { settingText } from "./settings";

import type { JudgeRoad } from "./gate-judge";
import type { SynthAnswer, SynthAsker } from "./laya-synth-run";

// A second road for a gate whose rows codex will not write: `llm_query` on the local-model road's MCP
// service, the qwen model the deployment runs itself (docs/gate-data.md 「The local-model road」). It
// is chosen for the sanitizer gate, whose rows are attack sentences the codex account reads as
// security work and refuses at the account level — a refusal no model choice inside codex undoes.
// The local model is not claude and answers the same rows without flinching, which is the whole of
// what the gate needs.
//
// The road holds no session and reads no cache: one request carries the gate's whole prefix afresh
// and the answer comes back as text, so nothing here resumes a thread. That is why a gate on this
// road is a run of independent batches rather than one held conversation.

// The model the service serves, as the tooling's settings name it (`local_model`), and the answer slot
// a batch of invented rows is given. A batch is a long answer — twenty rows, not a one-line verdict —
// and an answer cut off mid-list holds no rows at all, so the slot is sized well past what one batch
// needs.
export function localModel(): string {
  return settingText("local_model");
}

export const localEffort = "none";
export const localAnswerTokens = 16_384;

// The service is one model shared by many and a batch is minutes of writing, so the wait is sized
// like the codex road's rather than like a gate's own verdict.
export const localTimeoutMs = 600_000;

// The service's MCP address and its model list, as the settings name them (`local_mcp_url`,
// `local_models_url`).
export function localMcpUrl(): string {
  return settingText("local_mcp_url");
}

export function localModelsUrl(): string {
  return settingText("local_models_url");
}

export const localProtocolVersion = "2025-06-18";

export type LocalFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LocalSettings {
  mcpUrl: string;
  modelsUrl: string;
  model: string;
  answerTokens: number;
  timeoutMs: number;
  // Read apart so the whole road can be driven without a key or a network in a test.
  readKey: () => string;
  fetch: LocalFetch;
}

// Where the key lives: the file the settings name as `local_key_file` under the data root's `env/`,
// outside the checkout. It must be exactly 0600 or it is treated as absent rather than trusted with
// loose permissions.
export function localKeyPath(): string {
  return join(dataRoot(), "env", settingText("local_key_file"));
}

export function readLocalKey(path: string = localKeyPath()): string {
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
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": localProtocolVersion,
  });
}

// The request one batch is. The service takes no model argument on `llm_query` — it serves one
// model — so only the prefix, the batch's own ask and the answer slot go in.
export function localBody(system: string, prompt: string, answerTokens: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "llm_query", arguments: { system, prompt, max_tokens: answerTokens } },
  });
}

// The last JSON value carried by a Server-Sent-Events stream, where the service answers with one,
// read with `eventsource-parser`.
function eventStreamValue(body: string): unknown {
  const values: unknown[] = [];
  const parser = createParser({
    onEvent: (event) => {
      const data = event.data.trim();

      if (data !== "" && data !== "[DONE]") {
        values.push(JSON.parse(data));
      }
    },
  });

  parser.feed(body);
  parser.feed("\n\n");

  if (values.length === 0) {
    throw new Error("an empty event stream");
  }

  return values.at(-1);
}

// The rows out of one MCP answer, or a thrown error naming what was wrong with the shape. The
// answer is the text the tool result carries; a tool error, or a result marked as one, is a failed
// batch and is raised so the gate stops rather than freezing an empty answer.
export function readLocalAnswer(body: string, contentType: string | null): string {
  if (body.trim() === "") {
    throw new Error("an empty answer");
  }

  const value = contentType?.toLowerCase().includes("text/event-stream")
    ? eventStreamValue(body)
    : JSON.parse(body);

  if (typeof value !== "object" || value === null) {
    throw new Error("the answer is not a JSON object");
  }

  const envelope = value as { error?: unknown; result?: { isError?: unknown; content?: unknown } };

  if (envelope.error !== undefined || envelope.result?.isError === true) {
    throw new Error(`the service answered with an error: ${JSON.stringify(envelope.error ?? envelope.result?.content)}`);
  }

  const content = envelope.result?.content;

  if (!Array.isArray(content)) {
    throw new Error("the answer holds no content array");
  }

  const text = content
    .filter((part): part is { type: string; text: string } => (
      typeof part === "object" && part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (text === "") {
    throw new Error("the answer holds no text");
  }

  return text;
}

// The one model the service serves must be the one this road claims to write on, so a service that
// swapped its model out cannot label a different model's rows as qwen's. Checked once, since the
// list changes rarely and asking on every batch would double a gate's requests.
async function confirmModel(settings: LocalSettings, key: string): Promise<void> {
  const response = await settings.fetch(settings.modelsUrl, {
    headers: headers(key),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`the model list answered ${response.status}`);
  }

  const listed = ((await response.json()) as { data?: { id?: unknown }[] }).data ?? [];
  const ids = listed.map((one) => one.id).filter((id): id is string => typeof id === "string");

  if (ids.length !== 1 || ids[0] !== settings.model) {
    throw new Error(`the service serves ${ids.join(", ") || "no model"}, and this road writes on ${settings.model}`);
  }
}

function withDefaults(settings: Partial<LocalSettings>): LocalSettings {
  return {
    mcpUrl: settings.mcpUrl ?? localMcpUrl(),
    modelsUrl: settings.modelsUrl ?? localModelsUrl(),
    model: settings.model ?? localModel(),
    answerTokens: settings.answerTokens ?? localAnswerTokens,
    timeoutMs: settings.timeoutMs ?? localTimeoutMs,
    readKey: settings.readKey ?? (() => readLocalKey()),
    fetch: settings.fetch ?? ((input, init) => fetch(input, init)),
  };
}

// The road a judging pass rides here: one batch of real rows in, one answer out, and no session
// between them, so every batch carries the whole prefix afresh. A batch the service does not answer
// throws rather than coming back empty, which is the same contract the codex road keeps.
export function localJudgeRoad(settings: Partial<LocalSettings> = {}): JudgeRoad {
  const full = withDefaults(settings);
  let confirmed = false;

  return async (system, prompt) => {
    const key = full.readKey();

    if (!confirmed) {
      await confirmModel(full, key);
      confirmed = true;
    }

    const response = await full.fetch(full.mcpUrl, {
      method: "POST",
      headers: headers(key),
      body: localBody(system, prompt, full.answerTokens),
      signal: AbortSignal.timeout(full.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`the local model answered a judging batch with ${response.status}`);
    }

    return {
      text: readLocalAnswer(await response.text(), response.headers.get("content-type")),
      sessionId: null,
      tokens: noTokens,
    };
  };
}

// The asker `runSynthesis` drives on this road: one batch in, one answer out, no session between
// them. A batch that the service does not answer throws rather than coming back empty, so the gate
// stops at that batch and is taken up again where it left off — the same contract the codex road
// keeps.
export function localAsker(settings: Partial<LocalSettings> = {}): SynthAsker {
  const full = withDefaults(settings);
  let confirmed = false;

  return async (spec, ask): Promise<SynthAnswer> => {
    const key = full.readKey();

    if (!confirmed) {
      await confirmModel(full, key);
      confirmed = true;
    }

    const { system, prompt } = batchPrompts(spec, ask);
    const response = await full.fetch(full.mcpUrl, {
      method: "POST",
      headers: headers(key),
      body: localBody(system, prompt, full.answerTokens),
      signal: AbortSignal.timeout(full.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`${spec.gate} ${ask.seed}: the local model answered ${response.status}`);
    }

    const text = readLocalAnswer(await response.text(), response.headers.get("content-type"));

    // The MCP road reports no usage, so a batch on it carries no tokens. The ledger's zero here is
    // the absence of a reading, not a batch that cost nothing.
    return { text, sessionId: null, tokens: noTokens };
  };
}
