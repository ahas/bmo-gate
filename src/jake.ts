import { statSync } from "node:fs";
import { join } from "node:path";

import { homeDir } from "./roots";

// How this repository reaches a jake node: the console it drives, the three calls it hands that
// console — a command, a file carried to the node and a file brought back — and the runner that
// speaks to the console as a process. A node is reached through its hub rather than by SSH, so
// everything that touches a node goes through here, whatever it puts there.

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

/** The runner the commands use: the jake console, spoken to as a process. A call given a limit that
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
    ? `종료 코드 ${result.code}`
    : `시간 초과(${result.timedOut.seconds}초, ${result.timedOut.bytes.toLocaleString("en-US")}바이트)`;
  const whole = said === "" ? `${why}, 출력 없음` : `${why} — ${said}`;

  return (result.attempts ?? 1) > 1 ? `${result.attempts}번 해 봤어요, 마지막은 ${whole}` : whole;
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
    exec: (command) => runner(jakeExecArgs(console, agent, command), COMMAND_LIMIT),
    upload: (local, remote) =>
      twice(jakeUploadArgs(console, agent, local, remote), transferLimit(statSync(local, { throwIfNoEntry: false })?.size ?? 0)),
    download: (remote, local, bytes) => twice(jakeDownloadArgs(console, agent, remote, local), transferLimit(bytes)),
  };
}

/** The jake console this repository drives the nodes with. It is the owner's own checkout, outside
 * this one, which is where the machines and their access are kept. */
export function jakeConsole(): string {
  return join(homeDir(), "repos", "ahas", "jake", "src", "console", "main.ts");
}

export function jakeExecArgs(console: string, agent: string, command: string): string[] {
  return ["bun", console, "exec", "-a", agent, command];
}

export function jakeUploadArgs(console: string, agent: string, local: string, remote: string): string[] {
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
export function jakeDownloadArgs(console: string, agent: string, remote: string, local: string): string[] {
  return ["bun", console, "download", remote, local, "-a", agent];
}
