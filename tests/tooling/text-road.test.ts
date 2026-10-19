import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { scratchDir } from "./scratch";
import { synthesisFor } from "../../training/tooling/src/laya-synth";
import { SETTINGS_VARIABLE } from "../../training/tooling/src/settings";
import { textAsker, textBaseUrl, textBody, textJudgeRoad, textKeyPath, textModel as settingsModel, readTextAnswer, readTextKey } from "../../training/tooling/src/text-road";

import type { TextFetch, TextRoadSettings, TextSettings } from "../../training/tooling/src/text-road";
import type { SynthAsk } from "../../training/tooling/src/laya-synth";
import { useToolingSettings } from "./settings";

useToolingSettings({ text_base_url: "http://192.0.2.5:8020/v1" });

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
  { state: "\uD55C \uC904", questions: { intrusion: { type: "noul", instructions: "…" } }, gold: { intrusion: { type: "noul", label: "false", noul: 0.1, probabilities: { true: 0.1, false: 0.9 } } }, sanitized: "\uD55C \uC904" },
]);

function completion(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
  return JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });
}

// The model a test's road is handed, as the settings would give it, and the one the stub front lists.
const textModel = "Placed-Model.Q8_0";
const modelsList = JSON.stringify({ object: "list", data: [{ id: textModel, object: "model" }] });

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

// A fetch that answers the model list and the chat completion, recording what the completion was
// sent, so a test can drive the whole road without a network.
function stubFetch(chat: (sent: string) => Response): { fetch: TextFetch; sent: string[] } {
  const sent: string[] = [];
  const fetch: TextFetch = async (input, init) => {
    const url = String(input);

    if (url.endsWith("/models")) {
      return jsonResponse(modelsList);
    }

    sent.push(typeof init?.body === "string" ? init.body : "");

    return chat(sent.at(-1)!);
  };

  return { fetch, sent };
}

// What the front answers while its engine is set aside (the text model engine's own documents).
const asideRefusal = { error: { message: "set aside until 2026-10-04T12:00:00Z: a trainer", type: "set_aside", code: 503 } };

const settings = (fetch: TextFetch, extra: Partial<TextSettings> = {}): TextRoadSettings => ({
  model: textModel,
  fetch,
  readKey: () => "test-key",
  wait: async () => {},
  ...extra,
});

describe("reading one chat completion", () => {
  test("the answer is the message content, and the usage is split into fresh input and output", () => {
    const read = readTextAnswer(completion(rowsText, { prompt_tokens: 10, completion_tokens: 20 }));

    expect(read.text).toBe(rowsText);
    expect(read.tokens).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test("an answer with no usage carries no tokens", () => {
    expect(readTextAnswer(completion(rowsText)).tokens).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test("an answer with no content is raised, not returned empty", () => {
    expect(() => readTextAnswer(completion("   "))).toThrow("the answer holds no text");
  });
});

describe("the body a batch is", () => {
  test("carries the two messages, the model and the answer slot, and asks the model not to think", () => {
    const body = JSON.parse(textBody("sys", "usr", textModel, 4_096)) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens: number;
      chat_template_kwargs: { enable_thinking: boolean };
    };

    expect(body.model).toBe(textModel);
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "usr" }]);
    expect(body.max_tokens).toBe(4_096);
    expect(body.chat_template_kwargs.enable_thinking).toBe(false);
  });
});

describe("the asker", () => {
  test("confirms the served model once, then carries the answer and its tokens", async () => {
    const { fetch, sent } = stubFetch(() => jsonResponse(completion(rowsText, { prompt_tokens: 7, completion_tokens: 9 })));
    const asker = textAsker(settings(fetch));

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
    const fetch: TextFetch = async (input) =>
      String(input).endsWith("/models")
        ? jsonResponse(JSON.stringify({ data: [{ id: "some-other-model" }] }))
        : jsonResponse(completion(rowsText));
    const asker = textAsker(settings(fetch));

    await expect(asker(spec, ask, null)).rejects.toThrow("some-other-model");
  });

  test("waits out a busy card and then answers", async () => {
    let calls = 0;
    const { fetch } = stubFetch(() => {
      calls += 1;

      return calls === 1 ? jsonResponse("", 503) : jsonResponse(completion(rowsText));
    });
    const asker = textAsker(settings(fetch, { busyRetries: 3 }));

    expect((await asker(spec, ask, null)).text).toBe(rowsText);
    expect(calls).toBe(2);
  });

  test("waits out an empty completion and then answers", async () => {
    let calls = 0;
    const { fetch } = stubFetch(() => {
      calls += 1;

      return calls === 1 ? jsonResponse(completion("   ")) : jsonResponse(completion(rowsText));
    });
    const asker = textAsker(settings(fetch, { busyRetries: 3 }));

    expect((await asker(spec, ask, null)).text).toBe(rowsText);
    expect(calls).toBe(2);
  });

  test("gives up after the bounded number of busy tries, naming the gate and the seed", async () => {
    const { fetch } = stubFetch(() => jsonResponse("", 503));
    const asker = textAsker(settings(fetch, { busyRetries: 2 }));

    await expect(asker(spec, ask, null)).rejects.toThrow("sanitizer sanitizer-5");
  });

  test("an engine set aside stops the gate at once with the front's reason", async () => {
    let calls = 0;
    const { fetch } = stubFetch(() => {
      calls += 1;

      return jsonResponse(JSON.stringify(asideRefusal), 503);
    });
    const asker = textAsker(settings(fetch, { busyRetries: 3 }));

    await expect(asker(spec, ask, null)).rejects.toThrow("set aside until 2026-10-04T12:00:00Z: a trainer");
    expect(calls).toBe(1);
  });

  test("a non-busy failure stops the gate at once", async () => {
    const { fetch } = stubFetch(() => jsonResponse("nope", 500));
    const asker = textAsker(settings(fetch));

    await expect(asker(spec, ask, null)).rejects.toThrow("500");
  });
});

describe("the judging road", () => {
  test("carries one batch's answer with no session between batches", async () => {
    const { fetch } = stubFetch(() => jsonResponse(completion(rowsText, { prompt_tokens: 3, completion_tokens: 4 })));
    const road = textJudgeRoad(settings(fetch));

    const answer = await road("sys", "usr", null);

    expect(answer.text).toBe(rowsText);
    expect(answer.sessionId).toBeNull();
    expect(answer.tokens.outputTokens).toBe(4);
  });
});

describe("what the road writes on and with", () => {
  test("is the model, the front and the key file the settings name", () => {
    const where = scratchDir("bmo-text-road-settings-");
    const file = join(where, "tooling.toml");
    const before = { settings: process.env[SETTINGS_VARIABLE], data: process.env.BMO_DATA_DIR };

    writeFileSync(file, 'text_model = "Some-Model.Q8_0"\ntext_base_url = "http://192.0.2.5:8020/v1"\ntext_key_file = "text.token"\n');
    process.env[SETTINGS_VARIABLE] = file;
    process.env.BMO_DATA_DIR = where;

    try {
      expect([settingsModel(), textBaseUrl(), textKeyPath()]).toEqual(["Some-Model.Q8_0", "http://192.0.2.5:8020/v1", join(where, "env", "text.token")]);
    } finally {
      for (const [name, value] of [[SETTINGS_VARIABLE, before.settings], ["BMO_DATA_DIR", before.data]] as const) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

describe("the key", () => {
  test("a file with loose permissions is refused rather than trusted", () => {
    const path = join(scratchDir("bmo-text-key-"), "text.token");

    writeFileSync(path, "abc");
    chmodSync(path, 0o644);

    expect(() => readTextKey(path)).toThrow("0600");
  });

  test("a 0600 file is read and trimmed", () => {
    const path = join(scratchDir("bmo-text-key-"), "text.token");

    writeFileSync(path, "  secret\n");
    chmodSync(path, 0o600);

    expect(readTextKey(path)).toBe("secret");
  });
});
