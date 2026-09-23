import { describe, expect, test } from "bun:test";

import { j3090Asker, j3090Body, j3090Model, readJ3090Answer } from "./j3090-road";
import { synthesisFor } from "./laya-synth";

import type { J3090Fetch } from "./j3090-road";
import type { SynthAsk } from "./laya-synth";

const spec = synthesisFor("sanitizer")!;
const ask: SynthAsk = {
  gate: "sanitizer",
  count: 2,
  language: "korean",
  lean: true,
  room: "owner",
  edge: false,
  seed: "sanitizer-13",
};

// Two invented rows, the shape the gate asks for, as one JSON array. Kept short and harmless — the
// road's job is to carry whatever the model answers, and the test only checks that it carries it.
const rowsText = JSON.stringify([
  { state: "한 줄", questions: { intrusion: { type: "noul", instructions: "…" } }, gold: { intrusion: { type: "noul", label: "false", noul: 0.1, probabilities: { true: 0.1, false: 0.9 } } } },
  { state: "다른 줄", questions: { intrusion: { type: "noul", instructions: "…" } }, gold: { intrusion: { type: "noul", label: "true", noul: 0.9, probabilities: { true: 0.9, false: 0.1 } } } },
]);

function toolResult(text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

const modelsList = JSON.stringify({ object: "list", data: [{ id: j3090Model, object: "model" }] });

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

// A fetch that answers the model list and the MCP call, and records what the MCP call was sent.
function stubFetch(mcpBody: (sent: string) => Response): { fetch: J3090Fetch; sent: string[] } {
  const sent: string[] = [];
  const fetch: J3090Fetch = async (input, init) => {
    const url = String(input);

    if (url.endsWith("/v1/models")) {
      return jsonResponse(modelsList);
    }

    const body = typeof init?.body === "string" ? init.body : "";

    sent.push(body);

    return mcpBody(body);
  };

  return { fetch, sent };
}

describe("reading one MCP answer", () => {
  test("the rows are the text the tool result carried", () => {
    expect(readJ3090Answer(toolResult(rowsText), "application/json")).toBe(rowsText);
  });

  test("an event-stream answer is read down to its last value", () => {
    const stream = `event: message\ndata: ${toolResult(rowsText)}\n\ndata: [DONE]\n\n`;

    expect(readJ3090Answer(stream, "text/event-stream")).toBe(rowsText);
  });

  test("a tool error is raised, not returned as an answer", () => {
    const errored = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "무엇인가 잘못됨" }] } });

    expect(() => readJ3090Answer(errored, "application/json")).toThrow();
  });

  test("an empty body is raised", () => {
    expect(() => readJ3090Answer("", "application/json")).toThrow();
  });

  test("a result with no content array is raised", () => {
    expect(() => readJ3090Answer(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), "application/json")).toThrow();
  });
});

describe("the request one batch is", () => {
  test("carries the prefix, the ask and the answer slot, and no model", () => {
    const body = JSON.parse(j3090Body("PREFIX", "ASK", 16_384)) as {
      method: string;
      params: { name: string; arguments: Record<string, unknown> };
    };

    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("llm_query");
    expect(body.params.arguments).toEqual({ system: "PREFIX", prompt: "ASK", max_tokens: 16_384 });
    expect("model" in body.params.arguments).toBe(false);
  });
});

describe("the asker the run drives", () => {
  test("returns the answer with no session and no tokens", async () => {
    const { fetch, sent } = stubFetch(() => jsonResponse(toolResult(rowsText)));
    const answer = await j3090Asker({ fetch, readKey: () => "k" })(spec, ask, null);

    expect(answer.text).toBe(rowsText);
    expect(answer.sessionId).toBeNull();
    expect(answer.tokens).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // The gate's fixed prefix rode in the request, which is what a session-less road carries afresh
    // every batch.
    expect(sent[0]).toContain("무해화 게이트");
  });

  test("the model list is asked once, not once per batch", async () => {
    let lists = 0;
    const fetch: J3090Fetch = async (input, init) => {
      if (String(input).endsWith("/v1/models")) {
        lists += 1;

        return jsonResponse(modelsList);
      }

      return jsonResponse(toolResult(typeof init?.body === "string" && init.body.includes("14") ? rowsText : rowsText));
    };
    const asker = j3090Asker({ fetch, readKey: () => "k" });

    await asker(spec, ask, null);
    await asker(spec, { ...ask, seed: "sanitizer-14" }, null);

    expect(lists).toBe(1);
  });

  test("a service serving a different model is refused before a batch is sent", async () => {
    let mcpCalls = 0;
    const fetch: J3090Fetch = async (input) => {
      if (String(input).endsWith("/v1/models")) {
        return jsonResponse(JSON.stringify({ object: "list", data: [{ id: "someone-else-32b" }] }));
      }

      mcpCalls += 1;

      return jsonResponse(toolResult(rowsText));
    };

    await expect(j3090Asker({ fetch, readKey: () => "k" })(spec, ask, null)).rejects.toThrow();
    expect(mcpCalls).toBe(0);
  });

  test("a non-200 from the service is a failed batch", async () => {
    const { fetch } = stubFetch(() => new Response("upstream busy", { status: 503 }));

    await expect(j3090Asker({ fetch, readKey: () => "k" })(spec, ask, null)).rejects.toThrow();
  });
});
