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
}

/** How a command reaches a node. The one boundary to the world a caller of these has, so a test hands
 * it a stand-in and every decision above it is read without a machine. */
export type NodeRunner = (argv: readonly string[]) => Promise<RunResult>;

/** The runner the commands use: the jake console, spoken to as a process. */
export const spawnRunner: NodeRunner = async (argv) => {
  const going = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(going.stdout).text(), new Response(going.stderr).text()]);

  return { code: await going.exited, stdout, stderr };
};

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
