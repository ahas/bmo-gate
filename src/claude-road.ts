import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { emptyCwd } from "./codex-road";
import { noTokens } from "./laya-synth-run";

import type { JudgeRoad } from "./gate-judge";
import type { TokenTally } from "./laya-synth-run";

// The road a judging pass rides while the codex account is shut: Claude Code's print mode, pinned to
// one login (docs/gate-data.md 「The claude road」). It judges and writes no rows.
//
// One call is one batch and keeps no session: the judge's own lines stand in for the system prompt,
// the batch goes in on stdin, and one JSON result comes back.

export const claudeModel = "claude-sonnet-5";
export const claudeEffort = "high";

// The login this road is pinned to: the second account, whose credentials stand in `~/.claude`.
export const claudeAccount = "dev@ahas.io";

export function claudeConfigDir(): string {
  return join(homedir(), ".claude");
}

// A judging batch is a long answer at high effort, so the wait is sized like the codex road's.
export const claudeTimeoutMs = 600_000;

// Every variable that could carry a login other than the one the configuration directory holds. Any
// of them standing in the environment the road inherits would decide the account before the
// directory is ever read.
export const loginVariables = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export interface ClaudeReading {
  text: string;
  tokens: TokenTally;
  // Every model the result says it spent tokens on.
  models: string[];
  // Why the call did not finish, in the CLI's own words, or null where it did.
  failure: string | null;
}

// Running one command with a given environment and reading what it printed. It stands apart from
// the road so that everything the road does with an answer can be driven without the CLI.
export type ClaudeRun = (command: string[], saying: string, env: Record<string, string>) => Promise<ClaudeReading>;

export interface ClaudeSettings {
  model: string;
  effort: string;
  timeoutMs: number;
  configDir: string;
  account: string;
  // The account the configuration directory is logged into, or null where it names none.
  readAccount: (configDir: string) => string | null;
  run: ClaudeRun;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Input is already counted apart from the cache on this side, and thinking is inside the output.
export function claudeTokensOf(usage: ClaudeUsage | undefined): TokenTally {
  if (usage === undefined) {
    return noTokens;
  }

  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function objectOf(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

// What one print-mode call said. The result is the one JSON object carrying the result type; a
// result marked as an error — a spent limit, a refused model — is a failure carrying its own words.
export function readClaudeResult(stream: string): ClaudeReading {
  const result = stream.split("\n").map(objectOf).findLast((one) => one?.type === "result") ?? null;

  if (result === null) {
    return { text: "", tokens: noTokens, models: [], failure: "결과가 없습니다." };
  }

  const text = typeof result.result === "string" ? result.result : "";
  const usage = result.modelUsage;
  const models = typeof usage === "object" && usage !== null ? Object.keys(usage) : [];
  const failed = result.is_error === true || result.subtype !== "success";
  const words = text !== "" ? text : typeof result.subtype === "string" ? result.subtype : JSON.stringify(result);

  return {
    text: failed ? "" : text,
    tokens: claudeTokensOf(result.usage as ClaudeUsage | undefined),
    models,
    failure: failed ? words : null,
  };
}

// The command one batch is. Safe mode keeps this machine's `CLAUDE.md`, hooks, plugins, skills and
// MCP servers out of the batch, no tool is offered, the judge's lines replace the default system
// prompt, and nothing is kept of the session. No fallback model is named, so an answer is this
// model's or none.
export function claudeCommand(model: string, effort: string, system: string): string[] {
  return [
    "claude",
    "-p",
    "--output-format", "json",
    "--model", model,
    "--effort", effort,
    "--safe-mode",
    "--strict-mcp-config",
    "--tools", "",
    "--no-session-persistence",
    "--system-prompt", system,
  ];
}

// The environment one batch runs in: the inherited one, less every login variable, with the
// configuration directory named outright.
export function claudeEnvironment(inherited: NodeJS.ProcessEnv, configDir: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !(loginVariables as readonly string[]).includes(name)) {
      env[name] = value;
    }
  }

  env.CLAUDE_CONFIG_DIR = configDir;

  return env;
}

export function accountIn(configDir: string): string | null {
  try {
    const config = JSON.parse(readFileSync(join(configDir, ".claude.json"), "utf8")) as {
      oauthAccount?: { emailAddress?: unknown };
    };
    const address = config.oauthAccount?.emailAddress;

    return typeof address === "string" && address !== "" ? address : null;
  } catch {
    return null;
  }
}

export function spawnClaude(timeoutMs: number, cwd: string = emptyCwd()): ClaudeRun {
  return async (command, saying, env) => {
    const child = Bun.spawn(command, {
      cwd,
      env,
      stdin: new TextEncoder().encode(saying),
      stdout: "pipe",
      stderr: "pipe",
    });

    let ranOut = false;
    const timer = setTimeout(() => {
      ranOut = true;
      child.kill();
    }, timeoutMs);

    try {
      const [out, said] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const code = await child.exited;
      const reading = readClaudeResult(out);

      if (ranOut) {
        reading.failure = `${Math.round(timeoutMs / 1000)}초 안에 답이 오지 않아 끊었습니다.`;
      } else if (reading.failure !== null && code !== 0 && said.trim() !== "" && out.trim() === "") {
        // The CLI died before it printed a result — a missing program, a broken login — and what it
        // said on the way out is the only account of it.
        reading.failure = said.trim();
      }

      return reading;
    } finally {
      clearTimeout(timer);
    }
  };
}

function withDefaults(settings: Partial<ClaudeSettings>): ClaudeSettings {
  const timeoutMs = settings.timeoutMs ?? claudeTimeoutMs;

  return {
    model: settings.model ?? claudeModel,
    effort: settings.effort ?? claudeEffort,
    timeoutMs,
    configDir: settings.configDir ?? claudeConfigDir(),
    account: settings.account ?? claudeAccount,
    readAccount: settings.readAccount ?? accountIn,
    run: settings.run ?? spawnClaude(timeoutMs),
  };
}

// The road a judging pass rides here. The login is checked once, before the first batch, and a batch
// that failed or was answered by another model throws rather than coming back as an answer, so the
// gate stops at it and its frozen batches stand — the same contract the other two roads keep.
export function claudeJudgeRoad(settings: Partial<ClaudeSettings> = {}): JudgeRoad {
  const full = withDefaults(settings);
  let confirmed = false;

  return async (system, prompt) => {
    if (!confirmed) {
      const standing = full.readAccount(full.configDir);

      if (standing !== full.account) {
        throw new Error(`${full.configDir} 의 로그인은 ${standing ?? "없음"} 인데 이 길은 ${full.account} 에 못박혀 있습니다.`);
      }

      confirmed = true;
    }

    const reading = await full.run(
      claudeCommand(full.model, full.effort, system),
      prompt,
      claudeEnvironment(process.env, full.configDir),
    );

    if (reading.failure !== null) {
      throw new Error(`claude 가 판정 묶음을 쓰지 못했습니다 — ${reading.failure}`);
    }

    const strangers = reading.models.filter((model) => model !== full.model);

    if (strangers.length > 0 || !reading.models.includes(full.model)) {
      throw new Error(`판정 묶음에 ${full.model} 아닌 모델이 답했습니다 — ${reading.models.join(", ") || "없음"}`);
    }

    return { text: reading.text, sessionId: null, tokens: reading.tokens };
  };
}
