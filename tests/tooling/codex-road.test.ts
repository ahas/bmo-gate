import { describe, expect, test } from "bun:test";

import {
  batchSaying,
  codexAsker,
  codexCommand,
  codexEffort,
  codexModel,
  readCodexEvents,
  tokensOf,
} from "../../training/tooling/src/codex-road";
import { noTokens } from "../../training/tooling/src/laya-synth-run";
import { synthesisFor } from "../../training/tooling/src/laya-synth";

import type { CodexRun } from "../../training/tooling/src/codex-road";
import type { SynthAsk } from "../../training/tooling/src/laya-synth";
import { useToolingSettings } from "./settings";

useToolingSettings();

// The streams below are what `codex exec --json` really printed, written out object by object so
// the shapes stand in the test rather than as one long escaped line.

const landed = [
  // Codex says this in plain words when it takes the prompt from stdin. It is not an event and
  // the reading passes over it.
  "Reading prompt from stdin...",
  JSON.stringify({ type: "thread.started", thread_id: "01a0ccf2-4f26-7f12-b443-17095e040217" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "PROBE_STDIN" } }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 13285, cached_input_tokens: 11008, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 0 },
  }),
].join("\n");

// What comes back when the account may not use the model it was given. The same words arrive
// twice, once as an error of its own and once inside the failed turn.
const rejected = JSON.stringify({
  type: "error",
  status: 400,
  error: { type: "invalid_request_error", message: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account." },
});

const failed = [
  JSON.stringify({ type: "thread.started", thread_id: "01a0ccf3-0b9a-7b92-9183-4cee2a4e32cc" }),
  // A completed item of the error kind: a notice about the run, not the run failing.
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "error", message: "Model metadata for `gpt-5-codex` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." },
  }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "error", message: rejected }),
  JSON.stringify({ type: "turn.failed", error: { message: rejected } }),
].join("\n");

// The same notice on a turn that goes on to finish, which is how it usually arrives.
const noticed = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-with-a-notice" }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata not found. Defaulting to fallback metadata." } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "[{\"state\":\"\uC4F4 \uC904\"}]" } }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 20735, cached_input_tokens: 13056, cache_write_input_tokens: 40, output_tokens: 900, reasoning_output_tokens: 100 },
  }),
].join("\n");

describe("reading what a codex run said", () => {
  test("the thread id is the thread the next batch resumes", () => {
    expect(readCodexEvents(landed).threadId).toBe("01a0ccf2-4f26-7f12-b443-17095e040217");
  });

  test("the answer is the agent's own message", () => {
    expect(readCodexEvents(landed).text).toBe("PROBE_STDIN");
  });

  test("a turn that finished has no failure", () => {
    expect(readCodexEvents(landed).failure).toBeNull();
  });

  test("the notice codex prints when it reads the prompt from stdin is not an event", () => {
    expect(readCodexEvents(landed).threadId).not.toBeNull();
    expect(readCodexEvents(`not json at all\n${landed}\nnor this`).text).toBe("PROBE_STDIN");
  });

  test("a line that parses but is not an object is passed over", () => {
    expect(readCodexEvents(`[1,2,3]\n"a string"\nnull\n${landed}`).text).toBe("PROBE_STDIN");
  });

  test("an empty stream says nothing rather than throwing", () => {
    expect(readCodexEvents("")).toEqual({ threadId: null, text: "", tokens: noTokens, failure: null });
  });

  test("the last agent message is the answer, since it is the one the run ended on", () => {
    const twice = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "\uBA3C\uC800 \uC4F4 \uAC83" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "\uB9C8\uC9C0\uB9C9\uC5D0 \uC4F4 \uAC83" } }),
    ].join("\n");

    expect(readCodexEvents(twice).text).toBe("\uB9C8\uC9C0\uB9C9\uC5D0 \uC4F4 \uAC83");
  });
});

describe("a completed item of the error kind", () => {
  test("does not make the batch a failure", () => {
    expect(readCodexEvents(noticed).failure).toBeNull();
  });

  test("does not stand in for the answer", () => {
    expect(readCodexEvents(noticed).text).toBe("[{\"state\":\"\uC4F4 \uC904\"}]");
  });

  test("leaves the turn's usage alone", () => {
    expect(readCodexEvents(noticed).tokens.cacheReadTokens).toBe(13056);
  });
});

describe("a turn that failed", () => {
  test("is a failed batch and carries codex's own words", () => {
    const reading = readCodexEvents(failed);

    expect(reading.failure).not.toBeNull();
    expect(reading.failure).toContain("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.");
  });

  test("names the thread it died in, so the run can still be taken up", () => {
    expect(readCodexEvents(failed).threadId).toBe("01a0ccf3-0b9a-7b92-9183-4cee2a4e32cc");
  });

  test("spent nothing that was reported, so the tally stays empty", () => {
    expect(readCodexEvents(failed).tokens).toEqual(noTokens);
  });

  test("a failed turn on its own is read the same way", () => {
    const alone = JSON.stringify({ type: "turn.failed", error: { message: "\uC4F0\uB7EC\uC84C\uC2B5\uB2C8\uB2E4" } });

    expect(readCodexEvents(alone).failure).toBe("\uC4F0\uB7EC\uC84C\uC2B5\uB2C8\uB2E4");
  });

  test("a failure carrying no words at all is still a failure", () => {
    expect(readCodexEvents(JSON.stringify({ type: "turn.failed" })).failure).toContain("turn.failed");
  });
});

describe("what a turn spent", () => {
  test("fresh input is what was not read from the cache", () => {
    // Codex counts the cached part inside its input figure. Taking it whole would say 13,285.
    expect(tokensOf({ input_tokens: 13285, cached_input_tokens: 11008, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 0 }).inputTokens).toBe(2277);
  });

  test("the cached part is kept as the cache read", () => {
    expect(tokensOf({ input_tokens: 13285, cached_input_tokens: 11008, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 0 }).cacheReadTokens).toBe(11008);
  });

  test("thinking is output, because it is paid for as output", () => {
    expect(tokensOf({ input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 900, reasoning_output_tokens: 100 }).outputTokens).toBe(1000);
  });

  test("cache writes are their own figure", () => {
    expect(tokensOf({ input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 77, output_tokens: 1, reasoning_output_tokens: 0 }).cacheWriteTokens).toBe(77);
  });

  test("a cached figure larger than the input figure never turns fresh input negative", () => {
    expect(tokensOf({ input_tokens: 5, cached_input_tokens: 9, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }).inputTokens).toBe(0);
  });
});

describe("the command one batch is", () => {
  test("a gate's first batch opens a thread", () => {
    const command = codexCommand(codexModel, codexEffort, null);

    expect(command.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(command).not.toContain("resume");
  });

  test("every later batch resumes the thread it was handed and reads its prompt from stdin", () => {
    expect(codexCommand(codexModel, codexEffort, "thread-1").slice(0, 5))
      .toEqual(["codex", "exec", "resume", "thread-1", "-"]);
  });

  test("the model and the effort are named on a resumed call too, or the account refuses its own default", () => {
    for (const thread of [null, "thread-1"]) {
      const command = codexCommand("gpt-5.6-terra", "high", thread);

      expect(command).toContain("-m");
      expect(command[command.indexOf("-m") + 1]).toBe("gpt-5.6-terra");
      expect(command).toContain("model_reasoning_effort=high");
    }
  });

  test("it asks for the event stream and blocks on nothing", () => {
    for (const thread of [null, "thread-1"]) {
      const command = codexCommand(codexModel, codexEffort, thread);

      expect(command).toContain("--json");
      expect(command).toContain("--skip-git-repo-check");
      expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    }
  });

  test("no output schema is asked for", () => {
    expect(codexCommand(codexModel, codexEffort, null)).not.toContain("--output-schema");
  });
});

describe("what a batch says", () => {
  test("a gate's first batch carries the fixed prefix in front of its ask", () => {
    expect(batchSaying("\uAC8C\uC774\uD2B8 \uADDC\uCE59", "\uC774 \uBB36\uC74C\uC758 \uC694\uCCAD", null)).toBe("\uAC8C\uC774\uD2B8 \uADDC\uCE59\n\n\uC774 \uBB36\uC74C\uC758 \uC694\uCCAD");
  });

  test("a resumed batch says only its own ask, because the thread already holds the prefix", () => {
    expect(batchSaying("\uAC8C\uC774\uD2B8 \uADDC\uCE59", "\uC774 \uBB36\uC74C\uC758 \uC694\uCCAD", "thread-1")).toBe("\uC774 \uBB36\uC74C\uC758 \uC694\uCCAD");
  });
});

const sanitizer = synthesisFor("sanitizer")!;

const ask: SynthAsk = {
  gate: "sanitizer",
  count: 2,
  language: "korean",
  lean: true,
  room: "owner",
  edge: false,
  seed: "sanitizer-1",
};

function saying(stream: string): { run: CodexRun; commands: string[][]; saids: string[] } {
  const commands: string[][] = [];
  const saids: string[] = [];

  return {
    commands,
    saids,
    run: async (command, said) => {
      commands.push(command);
      saids.push(said);

      return readCodexEvents(stream);
    },
  };
}

describe("the asker a run is driven with", () => {
  test("hands back the answer, the thread and the tally", async () => {
    const heard = saying(landed);
    const answer = await codexAsker({ run: heard.run })(sanitizer, ask, null);

    expect(answer.text).toBe("PROBE_STDIN");
    expect(answer.sessionId).toBe("01a0ccf2-4f26-7f12-b443-17095e040217");
    expect(answer.tokens.inputTokens).toBe(2277);
    expect(answer.tokens.cacheReadTokens).toBe(11008);
  });

  test("sends the gate's prefix on the first batch and leaves it off afterwards", async () => {
    const heard = saying(landed);
    const asker = codexAsker({ run: heard.run });

    await asker(sanitizer, ask, null);
    await asker(sanitizer, ask, "01a0ccf2-4f26-7f12-b443-17095e040217");

    expect(heard.saids[0]!.length).toBeGreaterThan(heard.saids[1]!.length);
    expect(heard.commands[0]).not.toContain("resume");
    expect(heard.commands[1]).toContain("resume");
    expect(heard.commands[1]).toContain("01a0ccf2-4f26-7f12-b443-17095e040217");
  });

  test("a failed turn stops the run rather than coming back as an empty answer", async () => {
    const heard = saying(failed);

    await expect(codexAsker({ run: heard.run })(sanitizer, ask, null))
      .rejects.toThrow("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.");
  });

  test("the batch that failed is named, so a run says which one it lost", async () => {
    const heard = saying(failed);

    await expect(codexAsker({ run: heard.run })(sanitizer, ask, null)).rejects.toThrow("sanitizer-1");
  });

  test("a turn carrying only a notice comes back as an answer", async () => {
    const heard = saying(noticed);
    const answer = await codexAsker({ run: heard.run })(sanitizer, ask, null);

    expect(answer.text).toBe("[{\"state\":\"\uC4F4 \uC904\"}]");
  });
});
