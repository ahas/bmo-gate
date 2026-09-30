import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installN5Llm, N5_FILES } from "./n5-llm-install";
import { scratchDir } from "./scratch";

import type { NodeRunner, RunResult } from "./jake";

// What the text model on n5 answers the shared tunnelled install with: its files, its settings, its
// units, its listen on main-host and its place in the door's list. The steps themselves are checked
// through the Laya service in llm-install.test.ts.

const TUNNEL_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeN5TunnelKeyBody0123456789abcdefghij n5-llm-tunnel@n5";
const answer = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });

describe("the n5 text model's install", () => {
  test("carries its own files, settings and units, and asks for its own listen and door entry", async () => {
    const root = scratchDir("bmo-n5-llm-install-");
    const hostKeyPath = join(root, "host.pub");
    writeFileSync(hostKeyPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHost root@main-host\n");
    mkdirSync(join(root, "tmp"));
    const keyPath = join(root, "data", "env", "n5-llm.token");
    const doorListPath = join(root, "data", "env", "tunnel-door.keys");
    const authorizedKeysPath = join(root, "home", ".ssh", "authorized_keys");
    const uploads: Array<{ local: string; remote: string; text: string | null }> = [];
    const commands: string[] = [];

    const runner: NodeRunner = async (argv) => {
      if (argv[2] === "upload") {
        const local = argv[3]!;
        uploads.push({ local, remote: argv[4]!, text: existsSync(local) ? readFileSync(local, "utf8") : null });
        return answer("");
      }
      const command = argv[5] ?? "";
      commands.push(command);
      if (command.startsWith("echo HOME")) {
        return answer("HOME=/home/labuser\n");
      }
      if (command.includes("setup.log 2>/dev/null")) {
        return answer("N5-LLM-SETUP-DONE ok\n");
      }
      return answer(command.includes("ssh-keygen") ? `${TUNNEL_PUB}\n` : "launched\n");
    };

    const outcome = await installN5Llm({
      runner, console: "/jake/main.ts", checkout: "/checkout", keyPath, doorListPath, authorizedKeysPath, hostKeyPath,
      tmpRoot: join(root, "tmp"), local: async () => answer(""), health: async () => true, wait: async () => {}, setupPolls: 2,
    });

    expect(outcome.ok).toBe(true);
    expect(commands[1]).toBe("mkdir -p ~/n5-llm/models ~/.config/n5-llm && chmod 700 ~/.config/n5-llm");
    const key = readFileSync(keyPath, "utf8").trim();
    expect(uploads[0]).toEqual({ local: expect.any(String), remote: "/home/labuser/.config/n5-llm/env", text: `LLM_KEY=${key}\n` });
    expect(uploads.slice(1, 2 + N5_FILES.length).map((one) => [one.local, one.remote])).toEqual([
      ...N5_FILES.map((name) => [`/checkout/n5-llm/${name}`, `/home/labuser/n5-llm/${name}`]),
      ["/checkout/llm-server/ws-dial.py", "/home/labuser/n5-llm/ws-dial.py"],
    ]);
    expect(commands.some((command) => command.includes("-C n5-llm-tunnel@n5"))).toBe(true);
    expect(commands.at(-1)).toContain("systemctl --user enable n5-llm-front.service n5-llm-tunnel.service");
    expect(readFileSync(authorizedKeysPath, "utf8")).toContain('permitlisten="127.0.0.1:18020"');
    expect(readFileSync(doorListPath, "utf8")).toBe(`${keyPath}\n`);
  });
});
