import { describe, expect, test } from "bun:test";

import {
  claudeAsker,
  claudeCommand,
  claudeEffort,
  claudeEnvironment,
  claudeJudgeRoad,
  claudeModel,
  loginVariables,
  readClaudeResult,
} from "./claude-road";
import { synthesisFor } from "./laya-synth";
import { batchPrompts, noTokens, plannedBatches } from "./laya-synth-run";

import type { ClaudeReading, ClaudeRun } from "./claude-road";

// The result objects below follow what `claude -p --output-format json` printed, cut to the fields
// the road reads.

const landed = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "[{\"id\":\"a\"}]",
  usage: { input_tokens: 849, cache_creation_input_tokens: 12, cache_read_input_tokens: 30, output_tokens: 5 },
  modelUsage: { "claude-sonnet-5": { inputTokens: 849, outputTokens: 5 } },
});

const limited = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  result: "You've hit your limit · resets 3pm",
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {},
});

describe("reading what a print-mode call said", () => {
  test("the answer is the result text", () => {
    expect(readClaudeResult(landed).text).toBe("[{\"id\":\"a\"}]");
    expect(readClaudeResult(landed).failure).toBeNull();
  });

  test("the usage keeps fresh input, cache reads, cache writes and output apart", () => {
    expect(readClaudeResult(landed).tokens).toEqual({
      inputTokens: 849, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 12,
    });
  });

  test("the models that spent tokens are read off the result", () => {
    expect(readClaudeResult(landed).models).toEqual(["claude-sonnet-5"]);
  });

  test("a result marked as an error is a failure carrying its words, not an answer", () => {
    const reading = readClaudeResult(limited);

    expect(reading.failure).toBe("You've hit your limit · resets 3pm");
    expect(reading.text).toBe("");
  });

  test("a stream holding no result is a failure", () => {
    expect(readClaudeResult("not json\n").failure).not.toBeNull();
    expect(readClaudeResult("").tokens).toEqual(noTokens);
  });
});

describe("the command one batch is", () => {
  const command = claudeCommand(claudeModel, claudeEffort, "SYSTEM");

  test("it names the model and the effort, and no fallback model", () => {
    expect(command.slice(command.indexOf("--model"), command.indexOf("--model") + 2)).toEqual(["--model", claudeModel]);
    expect(command.slice(command.indexOf("--effort"), command.indexOf("--effort") + 2)).toEqual(["--effort", claudeEffort]);
    expect(command).not.toContain("--fallback-model");
  });

  test("it runs bare of this machine's setup, with no tools and no kept session", () => {
    expect(command).toContain("--safe-mode");
    expect(command).toContain("--strict-mcp-config");
    expect(command.slice(command.indexOf("--tools"), command.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(command).toContain("--no-session-persistence");
  });

  test("the judge's lines replace the default system prompt", () => {
    expect(command.slice(command.indexOf("--system-prompt"), command.indexOf("--system-prompt") + 2))
      .toEqual(["--system-prompt", "SYSTEM"]);
  });
});

describe("the environment one batch runs in", () => {
  test("names the configuration directory and carries no other login", () => {
    const inherited = Object.fromEntries([
      ["PATH", "/bin"],
      ["CLAUDE_CONFIG_DIR", "/elsewhere"],
      ...loginVariables.map((name) => [name, "secret"]),
    ]);
    const env = claudeEnvironment(inherited, "/pinned");

    expect(env.CLAUDE_CONFIG_DIR).toBe("/pinned");
    expect(env.PATH).toBe("/bin");

    for (const name of loginVariables) {
      expect(env[name]).toBeUndefined();
    }
  });
});

function road(reading: Partial<ClaudeReading>, account = "pinned@example.com") {
  const calls: { command: string[]; saying: string; env: Record<string, string> }[] = [];
  const run: ClaudeRun = (command, saying, env) => {
    calls.push({ command, saying, env });

    return Promise.resolve({ text: "", tokens: noTokens, models: [claudeModel], failure: null, ...reading });
  };

  return {
    calls,
    judge: claudeJudgeRoad({ run, configDir: "/pinned", account: "pinned@example.com", readAccount: () => account }),
  };
}

describe("the judging road", () => {
  test("hands the answer back with no session, the prompt on stdin", async () => {
    const { calls, judge } = road({ text: "ANSWER" });
    const answer = await judge("SYSTEM", "PROMPT", null);

    expect(answer).toEqual({ text: "ANSWER", sessionId: null, tokens: noTokens });
    expect(calls[0]!.saying).toBe("PROMPT");
    expect(calls[0]!.env.CLAUDE_CONFIG_DIR).toBe("/pinned");
  });

  test("refuses to start where the directory is logged into another account", async () => {
    const { calls, judge } = road({ text: "ANSWER" }, "other@example.com");

    await expect(judge("SYSTEM", "PROMPT", null)).rejects.toThrow("other@example.com");
    expect(calls).toHaveLength(0);
  });

  test("a failed call throws with its words, so the gate stops where it is", async () => {
    const { judge } = road({ failure: "You've hit your limit · resets 3pm" });

    await expect(judge("SYSTEM", "PROMPT", null)).rejects.toThrow("You've hit your limit");
  });

  test("an answer from another model is a failed batch", async () => {
    const { judge } = road({ text: "ANSWER", models: ["claude-opus-5-5"] });

    await expect(judge("SYSTEM", "PROMPT", null)).rejects.toThrow("claude-opus-5-5");
  });
});

describe("the writing road", () => {
  const spec = synthesisFor("content-judge")!;
  const ask = plannedBatches(spec, 20, 20, "false")[0]!;

  function writer(reading: Partial<ClaudeReading>, account = "pinned@example.com") {
    const calls: { command: string[]; saying: string }[] = [];
    const run: ClaudeRun = (command, saying) => {
      calls.push({ command, saying });

      return Promise.resolve({ text: "", tokens: noTokens, models: [claudeModel], failure: null, ...reading });
    };

    return { calls, write: claudeAsker({ run, configDir: "/pinned", account: "pinned@example.com", readAccount: () => account }) };
  }

  test("the gate's fixed prefix is the system prompt and the batch's own ask goes on stdin", async () => {
    const { calls, write } = writer({ text: "[]" });
    const answer = await write(spec, ask, null);
    const { system, prompt } = batchPrompts(spec, ask);

    expect(answer.sessionId).toBeNull();
    expect(calls[0]!.command.at(-1)).toBe(system);
    expect(calls[0]!.saying).toBe(prompt);
  });

  test("keeps the judging road's pin: another login or another model stops the gate at its batch", async () => {
    await expect(writer({ text: "[]" }, "other@example.com").write(spec, ask, null)).rejects.toThrow("other@example.com");
    await expect(writer({ text: "[]", models: ["claude-opus-5-5"] }).write(spec, ask, null)).rejects.toThrow(`content-judge ${ask.seed}`);
  });
});
