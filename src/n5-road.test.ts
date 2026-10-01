import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { scratchDir } from "./scratch";
import { synthesisFor } from "./laya-synth";
import { cutSseEvents, n5Asker, n5Body, n5JudgeRoad, n5Model, n5Streamer, readN5Answer, readN5Key, readSseEvent, readyTextNodes } from "./n5-road";

import type { N5Fetch, N5Settings } from "./n5-road";
import type { SynthAsk } from "./laya-synth";

const spec = synthesisFor("sanitizer")!;
const ask: SynthAsk = {
  gate: "sanitizer",
  count: 2,
  language: "korean",
  lean: false,
  room: "owner",
  edge: false,
  seed: "sanitizer-5",
};

// A harmless answer, the shape the gate asks for, as one JSON array. Kept short and harmless — the
// road only has to carry whatever the model answers, and the test checks only that it carries it.
const rowsText = JSON.stringify([
  { state: "한 줄", questions: { intrusion: { type: "noul", instructions: "…" } }, gold: { intrusion: { type: "noul", label: "false", noul: 0.1, probabilities: { true: 0.1, false: 0.9 } } }, sanitized: "한 줄" },
]);

function completion(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
  return JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });
}

const modelsList = JSON.stringify({ object: "list", data: [{ id: n5Model, object: "model" }] });

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

// A fetch that answers the model list and the chat completion, recording what the completion was
// sent, so a test can drive the whole road without a network.
function stubFetch(chat: (sent: string) => Response): { fetch: N5Fetch; sent: string[] } {
  const sent: string[] = [];
  const fetch: N5Fetch = async (input, init) => {
    const url = String(input);

    if (url.endsWith("/models")) {
      return jsonResponse(modelsList);
    }

    sent.push(typeof init?.body === "string" ? init.body : "");

    return chat(sent.at(-1)!);
  };

  return { fetch, sent };
}

const settings = (fetch: N5Fetch, extra: Partial<N5Settings> = {}): Partial<N5Settings> => ({
  fetch,
  readKey: () => "test-key",
  wait: async () => {},
  ...extra,
});

describe("reading one chat completion", () => {
  test("the answer is the message content, and the usage is split into fresh input and output", () => {
    const read = readN5Answer(completion(rowsText, { prompt_tokens: 10, completion_tokens: 20 }));

    expect(read.text).toBe(rowsText);
    expect(read.tokens).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test("an answer with no usage carries no tokens", () => {
    expect(readN5Answer(completion(rowsText)).tokens).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test("an answer with no content is raised, not returned empty", () => {
    expect(() => readN5Answer(completion("   "))).toThrow("답에 글이 없습니다");
  });
});

describe("the body a batch is", () => {
  test("carries the two messages, the model and the answer slot, and asks the model not to think", () => {
    const body = JSON.parse(n5Body("sys", "usr", n5Model, 4_096)) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens: number;
      chat_template_kwargs: { enable_thinking: boolean };
    };

    expect(body.model).toBe(n5Model);
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "usr" }]);
    expect(body.max_tokens).toBe(4_096);
    expect(body.chat_template_kwargs.enable_thinking).toBe(false);
  });
});

describe("the asker", () => {
  test("confirms the served model once, then carries the answer and its tokens", async () => {
    const { fetch, sent } = stubFetch(() => jsonResponse(completion(rowsText, { prompt_tokens: 7, completion_tokens: 9 })));
    const asker = n5Asker(settings(fetch));

    const first = await asker(spec, ask, null);
    const second = await asker(spec, ask, null);

    expect(first.text).toBe(rowsText);
    expect(first.sessionId).toBeNull();
    expect(first.tokens.inputTokens).toBe(7);
    expect(second.text).toBe(rowsText);
    // Two batches, two completions — and the model list asked once.
    expect(sent).toHaveLength(2);
  });

  test("refuses a front serving a different model", async () => {
    const fetch: N5Fetch = async (input) =>
      String(input).endsWith("/models")
        ? jsonResponse(JSON.stringify({ data: [{ id: "some-other-model" }] }))
        : jsonResponse(completion(rowsText));
    const asker = n5Asker(settings(fetch));

    await expect(asker(spec, ask, null)).rejects.toThrow("some-other-model");
  });

  test("waits out a busy card and then answers", async () => {
    let calls = 0;
    const { fetch } = stubFetch(() => {
      calls += 1;

      return calls === 1 ? jsonResponse("", 503) : jsonResponse(completion(rowsText));
    });
    const asker = n5Asker(settings(fetch, { busyRetries: 3 }));

    expect((await asker(spec, ask, null)).text).toBe(rowsText);
    expect(calls).toBe(2);
  });

  test("waits out an empty completion and then answers", async () => {
    let calls = 0;
    const { fetch } = stubFetch(() => {
      calls += 1;

      return calls === 1 ? jsonResponse(completion("   ")) : jsonResponse(completion(rowsText));
    });
    const asker = n5Asker(settings(fetch, { busyRetries: 3 }));

    expect((await asker(spec, ask, null)).text).toBe(rowsText);
    expect(calls).toBe(2);
  });

  test("gives up after the bounded number of busy tries, naming the gate and the seed", async () => {
    const { fetch } = stubFetch(() => jsonResponse("", 503));
    const asker = n5Asker(settings(fetch, { busyRetries: 2 }));

    await expect(asker(spec, ask, null)).rejects.toThrow("sanitizer sanitizer-5");
  });

  test("a non-busy failure stops the gate at once", async () => {
    const { fetch } = stubFetch(() => jsonResponse("nope", 500));
    const asker = n5Asker(settings(fetch));

    await expect(asker(spec, ask, null)).rejects.toThrow("500");
  });
});

describe("the judging road", () => {
  test("carries one batch's answer with no session between batches", async () => {
    const { fetch } = stubFetch(() => jsonResponse(completion(rowsText, { prompt_tokens: 3, completion_tokens: 4 })));
    const road = n5JudgeRoad(settings(fetch));

    const answer = await road("sys", "usr", null);

    expect(answer.text).toBe(rowsText);
    expect(answer.sessionId).toBeNull();
    expect(answer.tokens.outputTokens).toBe(4);
  });
});

describe("the nodes a pass spreads over", () => {
  test("keeps the nodes whose health answers and names why the rest were left out", async () => {
    const answering: N5Fetch = async () => new Response("ok");
    const busy: N5Fetch = async () => new Response("busy", { status: 503 });
    const down: N5Fetch = async () => {
      throw new Error("connection refused");
    };

    expect(await readyTextNodes(["n5", "n2"], answering)).toEqual({
      ready: ["n5"],
      dropped: [["n2", "n2 는 답하는 텍스트 모델 노드가 아닙니다 (n5)."]],
    });
    expect((await readyTextNodes(["n5"], busy)).dropped).toEqual([["n5", "health 503"]]);
    expect((await readyTextNodes(["n5"], down)).dropped).toEqual([["n5", "connection refused"]]);
  });
});

describe("the key", () => {
  test("a file with loose permissions is refused rather than trusted", () => {
    const path = join(scratchDir("bmo-n5-key-"), "n5-llm.token");

    writeFileSync(path, "abc");
    chmodSync(path, 0o644);

    expect(() => readN5Key(path)).toThrow("0600");
  });

  test("a 0600 file is read and trimmed", () => {
    const path = join(scratchDir("bmo-n5-key-"), "n5-llm.token");

    writeFileSync(path, "  secret\n");
    chmodSync(path, 0o600);

    expect(readN5Key(path)).toBe("secret");
  });
});

describe("streaming a harvest", () => {
  test("cuts whole events and keeps the partial one for the next read", () => {
    const first = cutSseEvents("data: a\n\ndata: b\n\ndata: c");

    expect(first.events).toEqual(["data: a", "data: b"]);
    expect(first.rest).toBe("data: c");
  });

  test("reads a delta, the usage on the final chunk, and the end marker", () => {
    expect(readSseEvent(`data: ${JSON.stringify({ choices: [{ delta: { content: "한" } }] })}`).text).toBe("한");
    expect(readSseEvent(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}`).tokens)
      .toEqual({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(readSseEvent("data: [DONE]").done).toBe(true);
    expect(readSseEvent(": keep-alive").text).toBe("");
  });

  test("delivers the streamed text delta by delta and returns the whole of it", async () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "한 줄\n" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "두 줄" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");

    const fetch: N5Fetch = async (input) => String(input).endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: n5Model }] }), { status: 200 })
      : new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

    const streamer = n5Streamer({ readKey: () => "k", fetch, wait: async () => {} });
    const deltas: string[] = [];
    const answer = await streamer.stream("system", "prompt", (delta) => deltas.push(delta));

    expect(deltas).toEqual(["한 줄\n", "두 줄"]);
    expect(answer.text).toBe("한 줄\n두 줄");
    expect(answer.tokens.outputTokens).toBe(4);
  });
});
