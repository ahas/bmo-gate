import { describe, expect, test } from "bun:test";

import { connectionCalls, nodeListCommand, parseConnection, readConnection, reservedAgainst, scpUploadArgs, sshExecArgs } from "../../training/tooling/src/node-reach";

import type { NodeRunner } from "../../training/tooling/src/node-calls";

const HOME_PC = { kind: "ssh", host: "203.0.113.82", port: 22, user: "owner", keyPath: "/keys/id_node", shell: "posix", role: null } as const;

describe("a node's connection, read from the node unit's node list", () => {
  test("is asked of the node unit's command the settings name", () => {
    expect(nodeListCommand("office-pc", ["bmo-node", "--config", "/env/node.toml"]))
      .toEqual(["bmo-node", "--config", "/env/node.toml", "node", "--target", "office-pc"]);
  });

  test("an ssh node and a console node are read as they are listed", () => {
    expect(parseConnection('{"kind":"ssh","host":"203.0.113.82","port":22,"user":"owner","keyPath":"/keys/id_node"}')).toEqual(HOME_PC);
    expect(parseConnection('{"kind":"ssh","host":"box","port":2222,"user":"me","keyPath":null}'))
      .toEqual({ kind: "ssh", host: "box", port: 2222, user: "me", keyPath: null, shell: "posix", role: null });
    expect(parseConnection('{"kind":"hub","hubAddress":"http://127.0.0.1:8791","hubTokenFile":"~/hub.env","agentName":"lab_box","role":"engine"}'))
      .toEqual({ kind: "console", agent: "lab_box", hubUrl: "http://127.0.0.1:8791", tokenFile: "~/hub.env", role: "engine" });
  });

  test("a node reserved for one service carries that service alone", () => {
    expect(reservedAgainst("voice", "bravo", { role: "engine" })).toBe("bravo is reserved for engine in the node list, so voice may not stand on it");
    expect(reservedAgainst("engine", "bravo", { role: "engine" })).toBeNull();
    expect(reservedAgainst("voice", "office-pc", { role: null })).toBeNull();
    expect(reservedAgainst("voice", "foxtrot", { role: "engine+voice" })).toBeNull();
    expect(reservedAgainst("song", "foxtrot", { role: "engine+voice" })).toBe("foxtrot is reserved for engine+voice in the node list, so song may not stand on it");
  });

  test("an answer that is not a whole connection is none", () => {
    for (const text of ["", "no node named x", '{"kind":"ssh","host":"box"}', '{"kind":"hub","agentName":"a"}', '{"kind":"rdp"}']) {
      expect(parseConnection(text)).toBeNull();
    }
  });

  test("a node the list does not know says why", async () => {
    const runner: NodeRunner = async () => ({ code: 1, stdout: "", stderr: "no node named ghost\n" });

    expect(await readConnection("ghost", runner, ["bmo-node"])).toBe("ghost's connection could not be read from the node list — no node named ghost");
  });

  test("a node whose login answers in Windows PowerShell is refused, since every call here is bash", async () => {
    const runner: NodeRunner = async () => ({ code: 0, stdout: '{"kind":"ssh","host":"203.0.113.82","port":2222,"user":"tester","keyPath":null,"shell":"powershell","role":null}\n', stderr: "" });

    expect(await readConnection("office-pc", runner, ["bmo-node"])).toBe("office-pc logs into Windows PowerShell, so it takes no bash command");
  });
});

describe("the calls a connection answers", () => {
  test("an ssh node is a batch login with its own key that asks nobody anything", () => {
    const argv = sshExecArgs(HOME_PC, "echo HOME=$HOME");

    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("BatchMode=yes");
    // A node that has gone is told by the connection's keep-alive; nothing bounds the connect itself.
    expect(argv).toContain("ServerAliveInterval=30");
    expect(argv.some((word) => word.startsWith("ConnectTimeout"))).toBe(false);
    expect(argv.slice(argv.indexOf("-i"), argv.indexOf("-i") + 2)).toEqual(["-i", "/keys/id_node"]);
    expect(argv.slice(-2)).toEqual(["owner@203.0.113.82", "bash -c 'echo HOME=$HOME'"]);
    expect(scpUploadArgs(HOME_PC, "/tmp/env", "/srv/trainer/.config/bmo-llm/env").slice(-2))
      .toEqual(["/tmp/env", "owner@203.0.113.82:/srv/trainer/.config/bmo-llm/env"]);
  });

  test("an ssh node's command reaches bash whole, whatever shell the account logs into", () => {
    const command = "rm -f ~/x.part-* && echo 'it'\\''s'";
    const handed = sshExecArgs(HOME_PC, command).at(-1)!;
    const run = Bun.spawnSync(["sh", "-c", `printf %s ${handed.slice("bash -c ".length)}`]);

    expect(handed.startsWith("bash -c ")).toBe(true);
    expect(run.stdout.toString()).toBe(command);
  });

  test("a console node is driven through the console by its agent's name, not its node name", async () => {
    const seen: string[][] = [];
    const runner: NodeRunner = async (argv) => {
      seen.push([...argv]);
      return { code: 0, stdout: "", stderr: "" };
    };

    await connectionCalls({ kind: "console", agent: "lab_box", hubUrl: "http://h", tokenFile: "/t", role: null }, runner, "/console").exec("true");

    expect(seen).toEqual([["bun", "/console", "exec", "-a", "lab_box", "true"]]);
  });

  test("a copy to an ssh node that failed is made once more", async () => {
    let calls = 0;
    const runner: NodeRunner = async () => ({ code: ++calls === 1 ? 1 : 0, stdout: "", stderr: "" });

    const result = await connectionCalls(HOME_PC, runner, "/console").upload("/absent", "/remote");

    expect(result).toMatchObject({ code: 0, attempts: 2 });
  });
});
