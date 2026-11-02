import { settingText } from "./settings";

// How this project reaches a console node, one the node unit lists as reached through a hub: the
// console program it drives, the three calls it hands that console — a command, a file carried to the
// node and a file brought back — and the runner that speaks to the console as a process. Every call on
// a node, whichever way it is reached, is waited for until it ends (docs/training.md, 「Calls on a
// node」).

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** How many times the call was made, where it was made more than once. */
  attempts?: number;
}

/** How a command reaches a node. The one boundary to the world a caller of these has, so a test hands
 * it a stand-in and every decision above it is read without a machine. */
export type NodeRunner = (argv: readonly string[]) => Promise<RunResult>;

/** The runner the commands use: a program spoken to as a process, waited for until it exits. */
export const spawnRunner: NodeRunner = async (argv) => {
  const going = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(going.stdout).text(), new Response(going.stderr).text()]);

  return { code: await going.exited, stdout, stderr };
};

/** Why a call came back as it did, never empty: its exit code, with the tail of what it wrote —
 * stderr, or stdout where stderr was empty. */
export function runFault(result: RunResult): string {
  const said = (result.stderr.trim() || result.stdout.trim()).slice(-300);
  const why = `exit code ${result.code}`;
  const whole = said === "" ? `${why}, no output` : `${why} — ${said}`;

  return (result.attempts ?? 1) > 1 ? `tried ${result.attempts} times, the last ${whole}` : whole;
}

/** The three calls on one node. A transfer that failed is made once more before its caller hears of
 * it, since what breaks one is most often the tunnel of the moment. */
export interface NodeCalls {
  exec: (command: string) => Promise<RunResult>;
  upload: (local: string, remote: string) => Promise<RunResult>;
  download: (remote: string, local: string) => Promise<RunResult>;
}

export function nodeCalls(runner: NodeRunner, console: string, agent: string): NodeCalls {
  const twice = async (argv: readonly string[]): Promise<RunResult> => {
    const first = await runner(argv);

    return first.code === 0 ? first : { ...await runner(argv), attempts: 2 };
  };

  return {
    exec: (command) => runner(consoleExecArgs(console, agent, command)),
    upload: (local, remote) => twice(consoleUploadArgs(console, agent, local, remote)),
    download: (remote, local) => twice(consoleDownloadArgs(console, agent, remote, local)),
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
