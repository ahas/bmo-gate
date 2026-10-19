import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import {
  claudeAsker,
  claudeCommand,
  claudeEffort,
  claudeEnvironment,
  claudeJudgeRoad,
  claudeModel,
  loginVariables,
  readClaudeResult,
  spawnClaude,
} from "../../training/tooling/src/claude-road";
import { synthesisFor } from "../../training/tooling/src/laya-synth";
import { batchPrompts, noTokens, plannedBatches } from "../../training/tooling/src/laya-synth-run";

import type { ClaudeReading, ClaudeRun } from "../../training/tooling/src/claude-road";
import { useToolingSettings } from "./settings";

useToolingSettings({ claude_batch_command: ["/agency/bin/batch-apart"], claude_login: "/pinned", claude_account: "pinned@example.com" });

// The answer below follows what `agent claude batch` prints: the text, the model that wrote it, and each
// model's tokens, the program's own titling call among them.

const landed = JSON.stringify({
  text: "[{\"id\":\"a\"}]",
  model: "claude-sonnet-5",
  spend: [
    { model: "claude-sonnet-5", inputTokens: 800, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 12 },
    { model: "claude-haiku-5-5", inputTokens: 49, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ],
});

describe("reading what the verb printed", () => {
  test("the answer is the printed text", () => {
    expect(readClaudeResult(landed).text).toBe("[{\"id\":\"a\"}]");
    expect(readClaudeResult(landed).failure).toBeNull();
  });

  test("the spend is summed kind by kind, fresh input, cache reads, cache writes and output apart", () => {
    expect(readClaudeResult(landed).tokens).toEqual({
      inputTokens: 849, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 12,
    });
  });

  test("the model is the one that wrote the answer, never a small call spent beside it", () => {
    expect(readClaudeResult(landed).models).toEqual(["claude-sonnet-5"]);
  });

  test("anything but the verb's answer is a failure", () => {
    expect(readClaudeResult("not json").failure).not.toBeNull();
    expect(readClaudeResult(JSON.stringify({ text: "x" })).failure).not.toBeNull();
    expect(readClaudeResult("").tokens).toEqual(noTokens);
  });
});

describe("the command one batch is", () => {
  const settings = { command: ["/agency/bin/batch-apart", "--line", "judge"], model: claudeModel, effort: claudeEffort, configDir: "/pinned", timeoutMs: 600_000 };
  const command = claudeCommand(settings, "/private/system.md", "gate judging batch");
  const after = (flag: string) => command[command.indexOf(flag) + 1];

  test("it is the agency's batch command the settings name, never Claude Code in print mode", () => {
    expect(command.slice(0, 3)).toEqual(["/agency/bin/batch-apart", "--line", "judge"]);
    expect(command).not.toContain("-p");
    expect(command).not.toContain("--print");
  });

  test("it names the model and the effort, and no fallback model", () => {
    expect(after("--model")).toBe(claudeModel);
    expect(after("--effort")).toBe(claudeEffort);
    expect(command).not.toContain("--fallback-model");
  });

  test("it pins the login, hands the fixed part's file and bounds the run at the wait", () => {
    expect(after("--config-dir")).toBe("/pinned");
    expect(after("--system-file")).toBe("/private/system.md");
    expect(after("--title")).toBe("gate judging batch");
    expect(after("--bound-seconds")).toBe("600");
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

describe("running the verb", () => {
  const run = spawnClaude(10_000, "/");

  test("an answer printed on success is read, the batch going in on stdin", async () => {
    const echoed = await run(
      ["sh", "-c", "read -r batch; printf '{\"text\":\"%s\",\"spend\":[]}' \"$batch\""],
      "BATCH\n",
      { PATH: process.env.PATH ?? "" },
    );

    expect(echoed).toEqual({ text: "BATCH", tokens: noTokens, models: [], failure: null });
  });

  test("a failed verb is a failure carrying what it said on its error stream", async () => {
    const failed = await run(["sh", "-c", "echo 'claude usage limit reached' >&2; exit 1"], "", { PATH: process.env.PATH ?? "" });

    expect(failed.failure).toBe("claude usage limit reached");
    expect(failed.text).toBe("");
  });
});

interface Call {
  command: string[];
  saying: string;
  env: Record<string, string>;
  system: string;
  systemFile: string;
}

// A run that keeps what it was handed, the fixed part read out of its file while the call stands.
function keeping(reading: Partial<ClaudeReading>): { calls: Call[]; run: ClaudeRun } {
  const calls: Call[] = [];
  const run: ClaudeRun = (command, saying, env) => {
    const systemFile = command[command.indexOf("--system-file") + 1]!;

    calls.push({ command, saying, env, system: readFileSync(systemFile, "utf8"), systemFile });

    return Promise.resolve({ text: "", tokens: noTokens, models: [claudeModel], failure: null, ...reading });
  };

  return { calls, run };
}

function road(reading: Partial<ClaudeReading>, account = "pinned@example.com") {
  const { calls, run } = keeping(reading);

  return {
    calls,
    judge: claudeJudgeRoad({ run, configDir: "/pinned", account: "pinned@example.com", readAccount: () => account }),
  };
}

describe("the judging road", () => {
  test("hands the answer back with no session, the prompt on stdin and the fixed part in a file of its own", async () => {
    const { calls, judge } = road({ text: "ANSWER" });
    const answer = await judge("SYSTEM", "PROMPT", null);

    expect(answer).toEqual({ text: "ANSWER", sessionId: null, tokens: noTokens });
    expect(calls[0]!.saying).toBe("PROMPT");
    expect(calls[0]!.system).toBe("SYSTEM");
    expect(calls[0]!.env.CLAUDE_CONFIG_DIR).toBe("/pinned");
    expect(existsSync(calls[0]!.systemFile)).toBe(false);
  });

  test("refuses to start where the directory is logged into another account", async () => {
    const { calls, judge } = road({ text: "ANSWER" }, "other@example.com");

    await expect(judge("SYSTEM", "PROMPT", null)).rejects.toThrow("other@example.com");
    expect(calls).toHaveLength(0);
  });

  test("a failed call throws with its words, so the gate stops where it is", async () => {
    const { calls, judge } = road({ failure: "claude usage limit reached" });

    await expect(judge("SYSTEM", "PROMPT", null)).rejects.toThrow("claude usage limit reached");
    expect(existsSync(calls[0]!.systemFile)).toBe(false);
  });

  test("an answer from another model is a failed batch", async () => {
    const { judge } = road({ text: "ANSWER", models: ["claude-opus-5-5"] });

    await expect(judge("SYSTEM", "PROMPT", null)).rejects.toThrow("claude-opus-5-5");
  });
});

describe("the writing road", () => {
  const spec = synthesisFor("reply-wanted")!;
  const ask = plannedBatches(spec, 20, 20, "false")[0]!;

  function writer(reading: Partial<ClaudeReading>, account = "pinned@example.com") {
    const { calls, run } = keeping(reading);

    return { calls, write: claudeAsker({ run, configDir: "/pinned", account: "pinned@example.com", readAccount: () => account }) };
  }

  test("the gate's fixed prefix is the system prompt and the batch's own ask goes on stdin", async () => {
    const { calls, write } = writer({ text: "[]" });
    const answer = await write(spec, ask, null);
    const { system, prompt } = batchPrompts(spec, ask);

    expect(answer.sessionId).toBeNull();
    expect(calls[0]!.system).toBe(system);
    expect(calls[0]!.saying).toBe(prompt);
  });

  test("keeps the judging road's pin: another login or another model stops the gate at its batch", async () => {
    await expect(writer({ text: "[]" }, "other@example.com").write(spec, ask, null)).rejects.toThrow("other@example.com");
    await expect(writer({ text: "[]", models: ["claude-opus-5-5"] }).write(spec, ask, null)).rejects.toThrow(`reply-wanted ${ask.seed}`);
  });
});
