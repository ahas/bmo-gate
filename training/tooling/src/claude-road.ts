import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { batchPrompts, noTokens } from "./laya-synth-run";
import { settingText, settingWords } from "./settings";

import type { JudgeRoad } from "./gate-judge";
import type { SynthAnswer, SynthAsker, TokenTally } from "./laya-synth-run";

// The road a judging pass or a top-up run rides while the codex account is shut: Claude Code pinned to
// one login, each batch a run apart through the agency's batch command (docs/gate-data.md 「The claude
// road」).
//
// One call is one batch on a fresh session that nothing resumes: the batch's fixed part is the system
// prompt, the rest goes in on stdin, and the verb prints one JSON object, the answer and what each
// model spent.

export const claudeModel = "claude-sonnet-5";
export const claudeEffort = "high";

// The login this road is pinned to, and the directory its credentials stand in: the tooling's settings
// `claude_account` and `claude_login` (docs/training.md, 「The tooling and its settings」).
export function claudeAccount(): string {
  return settingText("claude_account");
}

export function claudeConfigDir(): string {
  return settingText("claude_login");
}

// The agency's command that runs one batch apart, as the settings' `claude_batch_command` names it; the
// road's own flags go after it.
export function batchCommand(): string[] {
  return settingWords("claude_batch_command");
}

// A judging batch is a long answer at high effort, so the wait is sized like the codex road's.
export const claudeTimeoutMs = 600_000;

// The verb cuts a batch at the wait and closes its pane; the kill stands behind that for a verb that
// never comes back, late enough not to leave the pane standing.
export const closingGraceMs = 60_000;

// Every variable that could carry a login other than the one the configuration directory holds. Any
// of them standing in the environment the road inherits would decide the account before the
// directory is ever read.
export const loginVariables = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export interface ClaudeReading {
  text: string;
  tokens: TokenTally;
  // The model that wrote the answer, as the verb names it; the program's own small calls beside it, such
  // as the one that titles its session, are spent but write no answer.
  models: string[];
  // Why the call did not finish, in the verb's own words, or null where it did.
  failure: string | null;
}

// Running one command with a given environment and reading what it printed. It stands apart from
// the road so that everything the road does with an answer can be driven without the verb.
export type ClaudeRun = (command: string[], saying: string, env: Record<string, string>) => Promise<ClaudeReading>;

export interface ClaudeSettings {
  model: string;
  effort: string;
  timeoutMs: number;
  configDir: string;
  account: string;
  // The agency's command that runs a batch, its words before the road's own flags.
  command: readonly string[];
  // The account the configuration directory is logged into, or null where it names none.
  readAccount: (configDir: string) => string | null;
  run: ClaudeRun;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function countOf(row: Record<string, unknown>, field: string): number {
  const value = row[field];

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// What the verb's answer spent, each kind summed over its models. Input is already counted apart from
// the cache, and thinking is inside the output.
export function claudeTokensOf(spend: Record<string, unknown>[]): TokenTally {
  return spend.reduce<TokenTally>((sum, row) => ({
    inputTokens: sum.inputTokens + countOf(row, "inputTokens"),
    outputTokens: sum.outputTokens + countOf(row, "outputTokens"),
    cacheReadTokens: sum.cacheReadTokens + countOf(row, "cacheReadTokens"),
    cacheWriteTokens: sum.cacheWriteTokens + countOf(row, "cacheWriteTokens"),
  }), noTokens);
}

// What one answered batch said: the one JSON object the verb prints, its text, the model that wrote it
// and its spend model by model. Anything else is a failure.
export function readClaudeResult(printed: string): ClaudeReading {
  let answer: Record<string, unknown> | null = null;

  try {
    answer = recordOf(JSON.parse(printed) as unknown);
  } catch {
    answer = null;
  }

  if (answer === null || typeof answer.text !== "string" || !Array.isArray(answer.spend)) {
    return { text: "", tokens: noTokens, models: [], failure: "no result" };
  }

  const spend = answer.spend.map(recordOf).filter((row) => row !== null);
  const models = typeof answer.model === "string" && answer.model !== "" ? [answer.model] : [];

  return { text: answer.text, tokens: claudeTokensOf(spend), models, failure: null };
}

// The command one batch is: the agency's, which runs the batch on Claude Code bare of this machine's
// setup — safe mode, no tools, no MCP server — on the model and effort named, with no fallback model,
// so an answer is this model's or none. The fixed part stands in the file named, and the title is
// what a person watching the run's pane reads.
export function claudeCommand(
  settings: Pick<ClaudeSettings, "command" | "model" | "effort" | "configDir" | "timeoutMs">,
  systemFile: string,
  title: string,
): string[] {
  return [
    ...settings.command,
    "--model", settings.model,
    "--effort", settings.effort,
    "--config-dir", settings.configDir,
    "--system-file", systemFile,
    "--title", title,
    "--bound-seconds", String(Math.max(1, Math.ceil(settings.timeoutMs / 1000))),
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

// A batch runs in a directory holding nothing, made for it and removed with it.
export function spawnClaude(timeoutMs: number, cwd?: string): ClaudeRun {
  return async (command, saying, env) => {
    const place = cwd ?? mkdtempSync(join(tmpdir(), "bmo-gate-claude-place-"));

    try {
      return await runIn(place, timeoutMs, command, saying, env);
    } finally {
      if (cwd === undefined) {
        rmSync(place, { recursive: true, force: true });
      }
    }
  };
}

async function runIn(cwd: string, timeoutMs: number, command: string[], saying: string, env: Record<string, string>): Promise<ClaudeReading> {
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
  }, timeoutMs + closingGraceMs);

  try {
    const [out, said] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    const failed = (failure: string): ClaudeReading => ({ text: "", tokens: noTokens, models: [], failure });

    if (ranOut) {
      return failed(`no answer came within ${Math.round(timeoutMs / 1000)}s, so it was cut off`);
    }

    if (code !== 0) {
      // The command says on its error stream why the batch came to no answer — a spent limit, a cut at
      // the bound, a missing program — and that is the whole account of it.
      return failed(said.trim() !== "" ? said.trim() : `the batch command exited ${code}`);
    }

    return readClaudeResult(out.trim());
  } finally {
    clearTimeout(timer);
  }
}

function withDefaults(settings: Partial<ClaudeSettings>): ClaudeSettings {
  const timeoutMs = settings.timeoutMs ?? claudeTimeoutMs;

  return {
    model: settings.model ?? claudeModel,
    effort: settings.effort ?? claudeEffort,
    timeoutMs,
    configDir: settings.configDir ?? claudeConfigDir(),
    account: settings.account ?? claudeAccount(),
    command: settings.command ?? batchCommand(),
    readAccount: settings.readAccount ?? accountIn,
    run: settings.run ?? spawnClaude(timeoutMs),
  };
}

// One run with the batch's fixed part in a file of its own, readable by this user alone and removed
// once the run is over.
async function withSystemFile<T>(system: string, use: (file: string) => Promise<T>): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), "bmo-gate-claude-"));
  const file = join(folder, "system.md");

  try {
    writeFileSync(file, system, { mode: 0o600 });

    return await use(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// One batch on this road, whatever the batch is. The login is checked once, before the first batch,
// and a batch that failed or was answered by another model throws rather than coming back as an
// answer, so the gate stops at it and its frozen batches stand — the same contract the other two
// roads keep.
function claudeBatches(
  settings: Partial<ClaudeSettings>,
  what: string,
): (system: string, prompt: string, title: string) => Promise<SynthAnswer> {
  const full = withDefaults(settings);
  let confirmed = false;

  return async (system, prompt, title) => {
    if (!confirmed) {
      const standing = full.readAccount(full.configDir);

      if (standing !== full.account) {
        throw new Error(`${full.configDir} is logged into ${standing ?? "nothing"}, and this road is pinned to ${full.account}.`);
      }

      confirmed = true;
    }

    const reading = await withSystemFile(system, (file) => full.run(
      claudeCommand(full, file, title),
      prompt,
      claudeEnvironment(process.env, full.configDir),
    ));

    if (reading.failure !== null) {
      throw new Error(`claude did not write the ${what} batch: ${reading.failure}`);
    }

    const strangers = reading.models.filter((model) => model !== full.model);

    if (strangers.length > 0 || !reading.models.includes(full.model)) {
      throw new Error(`a model other than ${full.model} answered the ${what} batch: ${reading.models.join(", ") || "none"}`);
    }

    return { text: reading.text, sessionId: null, tokens: reading.tokens };
  };
}

// The road a judging pass rides here.
export function claudeJudgeRoad(settings: Partial<ClaudeSettings> = {}): JudgeRoad {
  const batch = claudeBatches(settings, "judging");

  return (system, prompt) => batch(system, prompt, "gate judging batch");
}

// The road a top-up run writes its rows on here (docs/gate-data.md 「Invented data」). No session is
// held, so the gate's fixed prefix is the system prompt of every call.
export function claudeAsker(settings: Partial<ClaudeSettings> = {}): SynthAsker {
  const batch = claudeBatches(settings, "writing");

  return async (spec, ask) => {
    const { system, prompt } = batchPrompts(spec, ask);

    try {
      return await batch(system, prompt, `gate writing batch: ${spec.gate} ${ask.seed}`);
    } catch (trouble) {
      throw new Error(`${spec.gate} ${ask.seed}: ${trouble instanceof Error ? trouble.message : String(trouble)}`);
    }
  };
}
