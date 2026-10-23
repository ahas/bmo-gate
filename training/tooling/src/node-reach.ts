import { statSync } from "node:fs";
import { join } from "node:path";

import { COMMAND_LIMIT, nodeCalls, transferLimit } from "./node-calls";
import { homeDir } from "./roots";
import { settingWords } from "./settings";

import type { NodeCalls, NodeRunner, RunLimit, RunResult } from "./node-calls";

// How this project reaches a node by its registered name (docs/llm-server.md, 「The placement」).
// What a node is reached by belongs to the node unit's node list, so it is asked of the node unit's own
// command at every run; each connection type answers the same three calls — a command, a file carried to
// the node and a file brought back.

/** A node's connection as the node unit's node list gives it: never a credential, only where one is kept.
 * A console node is one the list reaches through a hub, by its agent's name. Beside it the node's role, the
 * services its row reserves it for, or null where it is reserved for none (the node unit's docs/nodes.md). */
export type NodeConnection = (
  | { kind: "ssh"; host: string; port: number; user: string; keyPath: string | null; shell: "posix" | "powershell" }
  | { kind: "console"; agent: string; hubUrl: string; tokenFile: string }
) & { role: string | null };

/** The node unit's own command, as the settings' `node_command` names it, asked for one node's connection
 * (the node unit's docs/nodes.md, 「Registering and changing a node」). */
export function nodeListCommand(name: string, command: readonly string[] = settingWords("node_command")): string[] {
  return [...command, "node", "--target", name];
}

function wordAt(value: Record<string, unknown>, key: string): string | null {
  const said = value[key];

  return typeof said === "string" && said !== "" ? said : null;
}

/** The connection out of the node command's answer, or null where it is not one. */
export function parseConnection(text: string): NodeConnection | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim().split("\n").at(-1) ?? "");
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const said = value as Record<string, unknown>;

  // A node reached through a hub: the node unit's target names the hub's address, the file its control
  // token is kept in and the agent's name (the node unit's `docs/api.md`, 「The target」).
  if (said.kind === "hub") {
    const agent = wordAt(said, "agentName");
    const hubUrl = wordAt(said, "hubAddress");
    const tokenFile = wordAt(said, "hubTokenFile");

    return agent === null || hubUrl === null || tokenFile === null ? null : { kind: "console", agent, hubUrl, tokenFile, role: wordAt(said, "role") };
  }

  const host = wordAt(said, "host");
  const user = wordAt(said, "user");
  const port = said.port;
  if (said.kind !== "ssh" || host === null || user === null || typeof port !== "number" || !Number.isInteger(port)) {
    return null;
  }

  return { kind: "ssh", host, port, user, keyPath: wordAt(said, "keyPath"), shell: said.shell === "powershell" ? "powershell" : "posix", role: wordAt(said, "role") };
}

/** The services a node's role names: one, or several joined by `+` (the node unit's docs/nodes.md, 「A node's role」). */
export function roleServices(role: string | null): string[] {
  return role === null ? [] : role.split("+");
}

/** Why a service may not stand on a node, or null where it may: a node whose row reserves it for services
 * carries those services alone. Each service asks it with its own name. */
export function reservedAgainst(service: string, node: string, connection: Pick<NodeConnection, "role">): string | null {
  return connection.role === null || roleServices(connection.role).includes(service)
    ? null
    : `${node} is reserved for ${connection.role} in the node list, so ${service} may not stand on it`;
}

/** The node's connection as the node list has it now, whatever shell it logs into, or why it could not be had. */
export async function readListedConnection(name: string, runner: NodeRunner, command?: readonly string[]): Promise<NodeConnection | string> {
  const asked = await runner(nodeListCommand(name, command), COMMAND_LIMIT);
  const connection = asked.code === 0 ? parseConnection(asked.stdout) : null;

  if (connection === null) {
    const said = (asked.stderr.trim() || asked.stdout.trim()).slice(-300);

    return `${name}'s connection could not be read from the node list${said === "" ? "" : ` — ${said}`}`;
  }

  return connection;
}

/** Why a node runs none of this project's calls, or null where it runs them: every call made on a node is
 * bash, which a login into Windows PowerShell never runs. */
export function withoutBash(name: string, connection: NodeConnection): string | null {
  return connection.kind === "ssh" && connection.shell === "powershell"
    ? `${name} logs into Windows PowerShell, so it takes no bash command`
    : null;
}

/** The node's connection as the node list has it now, or why it could not be had or takes no bash. */
export async function readConnection(name: string, runner: NodeRunner, command?: readonly string[]): Promise<NodeConnection | string> {
  const connection = await readListedConnection(name, runner, command);

  return typeof connection === "string" ? connection : withoutBash(name, connection) ?? connection;
}

function expanded(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homeDir(), path.slice(1)) : path;
}

/** What every batch login and copy to an ssh node is given: nobody is asked anything, the node's key
 * alone where it names one, and a host key taken the first time and held to after, as the node list's
 * own check does. */
export function sshOptions(target: Extract<NodeConnection, { kind: "ssh" }>, portFlag: "-p" | "-P"): string[] {
  const key = target.keyPath === null ? [] : ["-i", expanded(target.keyPath), "-o", "IdentitiesOnly=yes"];

  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", portFlag, String(target.port), ...key];
}

/** A command handed to bash inside the login, as a console node's agent runs one in bash, whatever shell the
 * account logs into: the steps here are written for bash, and a login shell such as zsh refuses a glob
 * that matches nothing where bash passes it on. */
export function sshExecArgs(target: Extract<NodeConnection, { kind: "ssh" }>, command: string): string[] {
  return ["ssh", ...sshOptions(target, "-p"), `${target.user}@${target.host}`, `bash -c '${command.replaceAll("'", "'\\''")}'`];
}

export function scpUploadArgs(target: Extract<NodeConnection, { kind: "ssh" }>, local: string, remote: string): string[] {
  return ["scp", "-q", ...sshOptions(target, "-P"), local, `${target.user}@${target.host}:${remote}`];
}

export function scpDownloadArgs(target: Extract<NodeConnection, { kind: "ssh" }>, remote: string, local: string): string[] {
  return ["scp", "-q", ...sshOptions(target, "-P"), `${target.user}@${target.host}:${remote}`, local];
}

/** The three calls on an ssh node: a batch login for a command, a copy each way for a file. A copy
 * that failed is made once more, as a console node's transfer is. */
export function sshNodeCalls(runner: NodeRunner, target: Extract<NodeConnection, { kind: "ssh" }>): NodeCalls {
  const twice = async (argv: readonly string[], limit: RunLimit): Promise<RunResult> => {
    const first = await runner(argv, limit);

    return first.code === 0 ? first : { ...await runner(argv, limit), attempts: 2 };
  };

  return {
    exec: (command) => runner(sshExecArgs(target, command), COMMAND_LIMIT),
    upload: (local, remote) =>
      twice(scpUploadArgs(target, local, remote), transferLimit(statSync(local, { throwIfNoEntry: false })?.size ?? 0)),
    download: (remote, local, bytes) => twice(scpDownloadArgs(target, remote, local), transferLimit(bytes)),
  };
}

/** The calls a connection answers: a console node through the console by its agent's name, an ssh node
 * by a batch login. */
export function connectionCalls(connection: NodeConnection, runner: NodeRunner, console: string): NodeCalls {
  return connection.kind === "console" ? nodeCalls(runner, console, connection.agent) : sshNodeCalls(runner, connection);
}

/** The node reached by its registered name, or why it could not be. */
export async function reachNode(name: string, runner: NodeRunner, console: string, command?: readonly string[]): Promise<NodeCalls | string> {
  const connection = await readConnection(name, runner, command);

  return typeof connection === "string" ? connection : connectionCalls(connection, runner, console);
}
