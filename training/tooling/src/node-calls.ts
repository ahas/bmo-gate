import { statSync } from "node:fs";

import { settingText } from "./settings";

// How this project reaches a console node, one the node unit lists as reached through a hub: the
// console program it drives, the three calls it hands that console — a command, a file carried to the
// node and a file brought back — and the runner that speaks to the console as a process. Every call on
// a node, whichever way it is reached, is bounded here.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set where the call outlived its limit and was killed: the limit in seconds and the bytes it
   * carried, or for a command the bytes it had answered by then. */
  timedOut?: { seconds: number; bytes: number };
  /** How many times the call was made, where it was made more than once. */
  attempts?: number;
}

/** How long a call may run before it is killed, and what it carries: a transfer's file size, or null
 * for a command. */
export interface RunLimit {
  ms: number;
  bytes: number | null;
}

/** How a command reaches a node. The one boundary to the world a caller of these has, so a test hands
 * it a stand-in and every decision above it is read without a machine. */
export type NodeRunner = (argv: readonly string[], limit?: RunLimit) => Promise<RunResult>;

// The tunnel has carried a checkpoint at fifteen megabytes a second and a dataset in a second, so a
// transfer is given twenty times the slowest of that and a minute to open. A command is given one
// minute more than the hub streams one for, since the hub stops a command itself at five.
const TRANSFER_OPEN_MS = 60_000;
const TRANSFER_BYTES_PER_SECOND = 1_000_000;
const COMMAND_MS = 6 * 60_000;
// What a stopped console is given to go before it is killed outright.
const KILL_GRACE_MS = 5_000;

export function transferLimit(bytes: number): RunLimit {
  return { ms: TRANSFER_OPEN_MS + Math.ceil(bytes * 1000 / TRANSFER_BYTES_PER_SECOND), bytes };
}

export const COMMAND_LIMIT: RunLimit = { ms: COMMAND_MS, bytes: null };

/** The runner the commands use: a program spoken to as a process. A call given a limit that
 * outlives it is stopped, and killed outright where it will not stop. */
export const spawnRunner: NodeRunner = async (argv, limit) => {
  const going = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  let outlived = false;
  let grace: Timer | undefined;
  const clock = limit === undefined ? undefined : setTimeout(() => {
    outlived = true;
    going.kill("SIGTERM");
    grace = setTimeout(() => going.kill("SIGKILL"), KILL_GRACE_MS);
  }, limit.ms);

  try {
    const [stdout, stderr] = await Promise.all([new Response(going.stdout).text(), new Response(going.stderr).text()]);
    const code = await going.exited;

    // A call that finished whole as it was being stopped did its work and is not a timeout.
    if (!outlived || limit === undefined || code === 0) {
      return { code, stdout, stderr };
    }
    const answered = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);

    return { code, stdout, stderr, timedOut: { seconds: Math.round(limit.ms / 1000), bytes: limit.bytes ?? answered } };
  } finally {
    clearTimeout(clock);
    clearTimeout(grace);
  }
};

/** Why a call came back as it did, never empty: the limit it outlived or its exit code, with the tail
 * of what it wrote — stderr, or stdout where stderr was empty. */
export function runFault(result: RunResult): string {
  const said = (result.stderr.trim() || result.stdout.trim()).slice(-300);
  const why = result.timedOut === undefined
    ? `exit code ${result.code}`
    : `timed out (${result.timedOut.seconds}s, ${result.timedOut.bytes.toLocaleString("en-US")} bytes)`;
  const whole = said === "" ? `${why}, no output` : `${why} — ${said}`;

  return (result.attempts ?? 1) > 1 ? `tried ${result.attempts} times, the last ${whole}` : whole;
}

/** The three calls on one node, each under its limit. A transfer that failed is made once more before
 * its caller hears of it, since what breaks one is most often the tunnel of the moment. */
export interface NodeCalls {
  exec: (command: string) => Promise<RunResult>;
  upload: (local: string, remote: string) => Promise<RunResult>;
  download: (remote: string, local: string, bytes: number) => Promise<RunResult>;
}

export function nodeCalls(runner: NodeRunner, console: string, agent: string): NodeCalls {
  const twice = async (argv: readonly string[], limit: RunLimit): Promise<RunResult> => {
    const first = await runner(argv, limit);

    return first.code === 0 ? first : { ...await runner(argv, limit), attempts: 2 };
  };

  return {
    exec: (command) => runner(consoleExecArgs(console, agent, command), COMMAND_LIMIT),
    upload: (local, remote) =>
      twice(consoleUploadArgs(console, agent, local, remote), transferLimit(statSync(local, { throwIfNoEntry: false })?.size ?? 0)),
    download: (remote, local, bytes) => twice(consoleDownloadArgs(console, agent, remote, local), transferLimit(bytes)),
  };
}

/** The console program a console node is driven through, as the settings' `node_console` names it
 * (docs/training.md, 「The tooling and its settings」). */
export function nodeConsole(): string {
  return settingText("node_console");
}

export function consoleExecArgs(console: string, agent: string, command: string): string[] {
  return ["bun", console, "exec", "-a", agent, command];
}

export function consoleUploadArgs(console: string, agent: string, local: string, remote: string): string[] {
  return ["bun", console, "upload", local, remote, "-a", agent];
}

/** Where the account's own folder is, asked of the node itself rather than assumed, since only the
 * node knows what its home is called. A transfer opens the path it is handed with no shell in the way,
 * so a path meant for one is written out whole from this. */
export function homeCommand(): string {
  return "echo HOME=$HOME";
}

export function parseHome(text: string): string | null {
  const said = /(?:^|\n)HOME=(\/\S+)/.exec(text)?.[1];

  return said === undefined || said === "" ? null : said;
}

/** The transfer that brings a file back, the one call that reads from a node rather than writing to
 * it. */
export function consoleDownloadArgs(console: string, agent: string, remote: string, local: string): string[] {
  return ["bun", console, "download", remote, local, "-a", agent];
}
