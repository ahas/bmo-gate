import { readFileSync } from "node:fs";

import { layaRequestParts } from "./laya";
import { RELAY_LISTEN, serviceKeyPath } from "./llm-install";

import type { LayaRequest } from "./laya";

// The Laya service as this project asks it: its health, which names the checkpoint serving
// each gate, and a decision on one input. Both go through the relay on the operations machine, or one node's own
// listen where a caller names it, with the service's key (docs/llm-server.md).

export function layaUrl(): string {
  return (process.env.BMO_LAYA_URL ?? `http://${RELAY_LISTEN}`).replace(/\/$/, "");
}

function serviceKey(): string | null {
  try {
    return readFileSync(serviceKeyPath(), "utf8").trim();
  } catch {
    return null;
  }
}

// The service's health, or null where it does not answer.
export async function layaHealth(url: string = layaUrl()): Promise<Record<string, unknown> | null> {
  const key = serviceKey();

  if (key === null) {
    return null;
  }

  try {
    const answer = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5_000) });
    const said: unknown = answer.status === 200 ? await answer.json() : null;

    return typeof said === "object" && said !== null ? said as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The checkpoint the engine's health says answers the gate, or null where it names none. */
export function servingCheckpoint(health: Record<string, unknown> | null, gate: string): string | null {
  const gates = health?.gates;
  const described = typeof gates === "object" && gates !== null ? (gates as Record<string, unknown>)[gate] : undefined;
  const model = typeof described === "object" && described !== null ? (described as Record<string, unknown>).model : undefined;

  return typeof model === "string" ? model : null;
}

// Every gate the service answers, with the checkpoint answering it.
export function servedCheckpoints(health: Record<string, unknown> | null): Map<string, string> {
  const gates = health?.gates;

  return new Map(typeof gates === "object" && gates !== null
    ? Object.keys(gates).flatMap((gate) => {
      const model = servingCheckpoint(health, gate);

      return model === null ? [] : [[gate, model] as [string, string]];
    })
    : []);
}

// One decision, asked in the calls the gate's client cuts the request into and joined into one reply; a
// call without an answer leaves the decision without one.
export async function layaDecide(
  gate: string,
  request: LayaRequest,
  url: string = layaUrl(),
  decide: (gate: string, part: LayaRequest, url: string) => Promise<unknown | null> = layaDecidePart,
): Promise<unknown | null> {
  const parts = layaRequestParts(request);

  if (parts.length === 1) {
    return await decide(gate, parts[0]!, url);
  }

  const replies = await Promise.all(parts.map((part) => decide(gate, part, url)));
  const answers = replies.map((reply) => typeof reply === "object" && reply !== null ? (reply as { answers?: unknown }).answers : null);

  return answers.every((one) => typeof one === "object" && one !== null) ? { answers: Object.assign({}, ...answers) as unknown } : null;
}

// One call, asked once more where the connection itself dropped: the service closes an idle
// connection the client may still be about to reuse, and that is not an answer about the input.
async function layaDecidePart(gate: string, request: LayaRequest, url: string): Promise<unknown | null> {
  const key = serviceKey();

  if (key === null) {
    return null;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reply = await fetch(`${url}/decide`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ gate, state: request.state, questions: request.questions }),
        signal: AbortSignal.timeout(30_000),
      });

      return reply.ok ? await reply.json() : null;
    } catch {
      // Asked again below, once.
    }
  }

  return null;
}
