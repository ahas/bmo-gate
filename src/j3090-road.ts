import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { batchPrompts, noTokens } from "./laya-synth-run";
import { dataRoot } from "./roots";

import type { JudgeRoad } from "./gate-judge";
import type { SynthAnswer, SynthAsker } from "./laya-synth-run";

// A second road for a gate whose rows codex will not write: `llm_query` on the J3090 MCP service,
// the qwen model that runs at home (docs/gate-data.md 「The J3090 road」). It is chosen for the
// sanitizer gate, whose rows are attack sentences the codex account reads as security work and
// refuses at the account level — a refusal no model choice inside codex undoes. J3090 is not
// claude and answers the same rows without flinching, which is the whole of what the gate needs.
//
// The road holds no session and reads no cache: one request carries the gate's whole prefix afresh
// and the answer comes back as text, so nothing here resumes a thread. That is why a gate on this
// road is a run of independent batches rather than one held conversation.

// The model the service serves and the answer slot a batch of invented rows is given. A batch is a
// long answer — twenty rows, not a one-line verdict — and an answer cut off mid-list holds no rows
// at all, so the slot is sized well past what one batch needs.
export const j3090Model = "qwen3.8-27b";
export const j3090Effort = "none";
export const j3090AnswerTokens = 16_384;

// The service is one model shared by many and a batch is minutes of writing, so the wait is sized
// like the codex road's rather than like a gate's own verdict.
export const j3090TimeoutMs = 600_000;

export const j3090McpUrl = "https://llm.d-vex.com/mcp";
export const j3090ModelsUrl = "https://llm.d-vex.com/v1/models";
export const j3090ProtocolVersion = "2025-06-18";

export type J3090Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface J3090Settings {
  mcpUrl: string;
  modelsUrl: string;
  model: string;
  answerTokens: number;
  timeoutMs: number;
  // Read apart so the whole road can be driven without a key or a network in a test.
  readKey: () => string;
  fetch: J3090Fetch;
}

// Where the key lives, outside the archive and the checkout, and it must be exactly 0600 or it is
// treated as absent rather than trusted with loose permissions.
export function j3090KeyPath(): string {
  return join(dataRoot(), "env", "j3090.key");
}

export function readJ3090Key(path: string = j3090KeyPath()): string {
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
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": j3090ProtocolVersion,
  });
}

// The request one batch is. The service takes no model argument on `llm_query` — it serves one
// model — so only the prefix, the batch's own ask and the answer slot go in.
export function j3090Body(system: string, prompt: string, answerTokens: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "llm_query", arguments: { system, prompt, max_tokens: answerTokens } },
  });
}

// The last JSON value carried by a Server-Sent-Events stream, where the service answers with one.
function eventStreamValue(body: string): unknown {
  const values: unknown[] = [];

  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (data === "" || data === "[DONE]") {
      continue;
    }

    values.push(JSON.parse(data));
  }

  if (values.length === 0) {
    throw new Error("빈 이벤트 스트림입니다.");
  }

  return values.at(-1);
}

// The rows out of one MCP answer, or a thrown error naming what was wrong with the shape. The
// answer is the text the tool result carries; a tool error, or a result marked as one, is a failed
// batch and is raised so the gate stops rather than freezing an empty answer.
export function readJ3090Answer(body: string, contentType: string | null): string {
  if (body.trim() === "") {
    throw new Error("빈 답입니다.");
  }

  const value = contentType?.toLowerCase().includes("text/event-stream")
    ? eventStreamValue(body)
    : JSON.parse(body);

  if (typeof value !== "object" || value === null) {
    throw new Error("답이 JSON 객체가 아닙니다.");
  }

  const envelope = value as { error?: unknown; result?: { isError?: unknown; content?: unknown } };

  if (envelope.error !== undefined || envelope.result?.isError === true) {
    throw new Error(`서비스가 오류를 냈습니다: ${JSON.stringify(envelope.error ?? envelope.result?.content)}`);
  }

  const content = envelope.result?.content;

  if (!Array.isArray(content)) {
    throw new Error("답에 content 배열이 없습니다.");
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
    throw new Error("답에 글이 없습니다.");
  }

  return text;
}

// The one model the service serves must be the one this road claims to write on, so a service that
// swapped its model out cannot label a different model's rows as qwen's. Checked once, since the
// list changes rarely and asking on every batch would double a gate's requests.
async function confirmModel(settings: J3090Settings, key: string): Promise<void> {
  const response = await settings.fetch(settings.modelsUrl, {
    headers: headers(key),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`모델 목록을 ${response.status} 로 받았습니다.`);
  }

  const listed = ((await response.json()) as { data?: { id?: unknown }[] }).data ?? [];
  const ids = listed.map((one) => one.id).filter((id): id is string => typeof id === "string");

  if (ids.length !== 1 || ids[0] !== settings.model) {
    throw new Error(`서비스가 서빙하는 모델은 ${ids.join(", ") || "없음"} 인데 이 길은 ${settings.model} 을 씁니다.`);
  }
}

function withDefaults(settings: Partial<J3090Settings>): J3090Settings {
  return {
    mcpUrl: settings.mcpUrl ?? j3090McpUrl,
    modelsUrl: settings.modelsUrl ?? j3090ModelsUrl,
    model: settings.model ?? j3090Model,
    answerTokens: settings.answerTokens ?? j3090AnswerTokens,
    timeoutMs: settings.timeoutMs ?? j3090TimeoutMs,
    readKey: settings.readKey ?? (() => readJ3090Key()),
    fetch: settings.fetch ?? ((input, init) => fetch(input, init)),
  };
}

// The road a judging pass rides here: one batch of real rows in, one answer out, and no session
// between them, so every batch carries the whole prefix afresh. A batch the service does not answer
// throws rather than coming back empty, which is the same contract the codex road keeps.
export function j3090JudgeRoad(settings: Partial<J3090Settings> = {}): JudgeRoad {
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
      body: j3090Body(system, prompt, full.answerTokens),
      signal: AbortSignal.timeout(full.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`J3090 이 판정 묶음에 ${response.status} 로 답했습니다.`);
    }

    return {
      text: readJ3090Answer(await response.text(), response.headers.get("content-type")),
      sessionId: null,
      tokens: noTokens,
    };
  };
}

// The asker `runSynthesis` drives on this road: one batch in, one answer out, no session between
// them. A batch that the service does not answer throws rather than coming back empty, so the gate
// stops at that batch and is taken up again where it left off — the same contract the codex road
// keeps.
export function j3090Asker(settings: Partial<J3090Settings> = {}): SynthAsker {
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
      body: j3090Body(system, prompt, full.answerTokens),
      signal: AbortSignal.timeout(full.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`${spec.gate} ${ask.seed}: J3090 이 ${response.status} 로 답했습니다.`);
    }

    const text = readJ3090Answer(await response.text(), response.headers.get("content-type"));

    // The MCP road reports no usage, so a batch on it carries no tokens. The ledger's zero here is
    // the absence of a reading, not a batch that cost nothing.
    return { text, sessionId: null, tokens: noTokens };
  };
}
