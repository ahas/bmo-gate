import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { batchPrompts, noTokens } from "./laya-synth-run";

import type { SynthAnswer, SynthAsker, TokenTally } from "./laya-synth-run";

// The road the rows are written on: `codex exec`, driven straight rather than through anything
// that would pick a provider for us (docs/gate-data.md 「The codex road」).
//
// One gate's whole run rides one codex thread. The first batch opens it and carries the gate's
// fixed prefix; every later batch resumes that thread and sends only its own ask, so the prefix is
// read out of the cache instead of being told again. Holding the thread is the entire reason a
// gate is a unit of work here.

// The tier this account writes at.
export const codexModel = "gpt-5.6-terra";
export const codexEffort = "high";

// A batch of twenty invented rows is minutes of writing, nowhere near a gate's one-word verdict.
export const codexTimeoutMs = 600_000;

// Running one command and reading what it said. The road has exactly one of these and it spawns
// codex; it stands apart from the asker so that everything the asker does with an answer can be
// driven from a stream without a model at the other end.
export type CodexRun = (command: string[], saying: string) => Promise<CodexReading>;

export interface CodexSettings {
  model: string;
  effort: string;
  timeoutMs: number;
  // Where the run is started from. It matters more than it looks: codex reads an `AGENTS.md` in
  // the directory it runs in and follows it, so a run started inside a checkout is a run with
  // that checkout's instructions silently prepended to every batch. The road runs in a directory
  // holding nothing at all.
  cwd: string;
  run: CodexRun;
}

let ownCwd: string | null = null;

// An empty directory of this process's own, made once and left empty.
export function emptyCwd(): string {
  ownCwd ??= mkdtempSync(join(tmpdir(), "bmo-gate-codex-"));

  return ownCwd;
}

// What codex says a turn spent. The input count already has the cached part inside it, which is
// the one thing about this shape worth knowing before reading a figure off it.
export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface CodexReading {
  // The thread this turn ran in, which the next batch of the same gate resumes.
  threadId: string | null;
  // The agent's own last message, which is where the rows are.
  text: string;
  tokens: TokenTally;
  // Why the turn did not finish, in codex's own words, or null where it did.
  failure: string | null;
}

export function tokensOf(usage: CodexUsage): TokenTally {
  return {
    // Fresh input is what was not read from the cache. Codex counts the cached part inside its
    // input figure, so taking that figure whole would report a batch that read almost all of its
    // prompt from the cache as though it had paid for the lot — which is the opposite of what
    // holding a thread per gate is for.
    inputTokens: Math.max(0, usage.input_tokens - usage.cached_input_tokens),
    // Thinking is output and is paid for as output, so it is counted as output.
    outputTokens: usage.output_tokens + usage.reasoning_output_tokens,
    cacheReadTokens: usage.cached_input_tokens,
    cacheWriteTokens: usage.cache_write_input_tokens,
  };
}

function textIn(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// What one `codex exec` run said, read off the event stream it printed. Anything that is not a
// JSON object on a line of its own is passed over: codex writes a plain notice when it takes the
// prompt from stdin, and a notice is not an event.
export function readCodexEvents(stream: string): CodexReading {
  const reading: CodexReading = { threadId: null, text: "", tokens: noTokens, failure: null };

  for (const line of stream.split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    let event: Record<string, unknown>;

    try {
      const parsed = JSON.parse(line) as unknown;

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        continue;
      }

      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === "thread.started") {
      reading.threadId = textIn(event.thread_id) ?? reading.threadId;
    }

    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;

      // An item of the error kind is a notice about the run — model metadata not found, and the
      // like — and the turn goes on to finish. Only a failed turn is a failed batch.
      if (item?.type === "agent_message") {
        reading.text = textIn(item.text) ?? reading.text;
      }
    }

    if (event.type === "turn.completed") {
      reading.tokens = tokensOf(event.usage as CodexUsage);
    }

    // Both of these stand on a turn that died, and the first one carries the same words, so
    // whichever arrives first is kept and the other does not write over it.
    if (event.type === "error" || event.type === "turn.failed") {
      const nested = event.error as Record<string, unknown> | undefined;

      reading.failure ??= textIn(event.message) ?? textIn(nested?.message) ?? JSON.stringify(event);
    }
  }

  return reading;
}

// The command one batch is. A gate's first batch opens a thread; every later one resumes the
// thread it was handed and reads its prompt from stdin, which is what the bare `-` asks for.
//
// The model and the effort are named on every call, resumed calls included. A resume that leaves
// the model out falls back to the account's own default, and this login refuses that default
// outright — so naming it only on the first batch would lose every batch after it.
export function codexCommand(model: string, effort: string, resumeThreadId: string | null): string[] {
  const opened = resumeThreadId === null ? ["exec"] : ["exec", "resume", resumeThreadId, "-"];

  return [
    "codex",
    ...opened,
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m", model,
    "-c", `model_reasoning_effort=${effort}`,
  ];
}

// What a batch says. The first batch of a gate carries the fixed prefix in front of its own ask,
// because codex takes no system prompt of its own and the thread's first message is what a
// resumed turn reads out of the cache.
export function batchSaying(system: string, prompt: string, resumeThreadId: string | null): string {
  return resumeThreadId === null ? `${system}\n\n${prompt}` : prompt;
}

export function spawnCodex(cwd: string, timeoutMs: number): CodexRun {
  return (command, saying) => runCodex(command, saying, cwd, timeoutMs);
}

async function runCodex(command: string[], saying: string, cwd: string, timeoutMs: number): Promise<CodexReading> {
  const child = Bun.spawn(command, {
    cwd,
    // The prompt goes in and the door shuts behind it. Codex handed a stdin nobody will ever
    // write to waits on it, says `Reading additional input from stdin...` and gives up.
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
    const reading = readCodexEvents(out);

    if (ranOut) {
      reading.failure ??= `${Math.round(timeoutMs / 1000)}초 안에 답이 오지 않아 끊었습니다.`;
    }

    // A run that printed no answer and no reason, and did not exit cleanly, failed somewhere the
    // event stream never reached — codex missing, a login gone. Whatever it said on the way out
    // is the only account of it there is.
    if (reading.failure === null && reading.text === "" && code !== 0) {
      reading.failure = said.trim() === "" ? `codex 가 ${code} 으로 끝났습니다.` : said.trim();
    }

    return reading;
  } finally {
    clearTimeout(timer);
  }
}

// The asker `runSynthesis` drives: one batch in, one answer out, and the thread carried between
// them. A failed turn throws rather than coming back as an answer with nothing in it. A batch that
// fails for a reason that will not change — a model this account may not use — would otherwise
// fail the same way every batch after it, and the run would spend a whole gate's plan writing
// down that it could not write anything. The run stops instead, and what is frozen is resumed.
export function codexAsker(settings: Partial<CodexSettings> = {}): SynthAsker {
  const model = settings.model ?? codexModel;
  const effort = settings.effort ?? codexEffort;
  const timeoutMs = settings.timeoutMs ?? codexTimeoutMs;
  const run = settings.run ?? spawnCodex(settings.cwd ?? emptyCwd(), timeoutMs);

  return async (spec, ask, resumeSessionId): Promise<SynthAnswer> => {
    const { system, prompt } = batchPrompts(spec, ask);
    const reading = await run(
      codexCommand(model, effort, resumeSessionId),
      batchSaying(system, prompt, resumeSessionId),
    );

    if (reading.failure !== null) {
      throw new Error(`${spec.gate} ${ask.seed}: codex 가 묶음을 쓰지 못했습니다 — ${reading.failure}`);
    }

    return { text: reading.text, sessionId: reading.threadId, tokens: reading.tokens };
  };
}
