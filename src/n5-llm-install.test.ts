import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { N5_FILES, N5_LLM_SERVICE, TEXT_NODES, installN5Llm, textBaseUrl, textKeyPath, textModelService } from "./n5-llm-install";
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
    expect(commands[1]).toBe("mkdir -p ~/n5-llm/models ~/n5-llm/slots ~/.config/n5-llm && chmod 700 ~/.config/n5-llm");
    const key = readFileSync(keyPath, "utf8").trim();
    expect(uploads[0]).toEqual({ local: expect.any(String), remote: "/home/labuser/.config/n5-llm/env", text: `LLM_KEY=${key}\nLISTEN=127.0.0.1:18020\n` });
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

describe("the text model service factory", () => {
  test("n5 keeps its old values, so importers that name it read the same service", () => {
    const n5 = textModelService("n5");

    expect(N5_LLM_SERVICE.node).toBe("n5");
    expect(N5_LLM_SERVICE.listen).toBe("127.0.0.1:18020");
    expect(N5_LLM_SERVICE.serviceDir).toBe("n5-llm");
    expect(N5_LLM_SERVICE.keyPath().endsWith("env/n5-llm.token")).toBe(true);
    expect(n5.node).toBe("n5");
    expect(n5.serviceDir).toBe("n5-llm");
    expect(n5.configDir).toBe(".config/n5-llm");
    expect(n5.listen).toBe("127.0.0.1:18020");
    expect(n5.engineUnit).toBe("n5-llm-front");
    expect(n5.units).toEqual(["n5-llm-front.service", "n5-llm-tunnel.service"]);
    expect(n5.keyPath().endsWith("env/n5-llm.token")).toBe(true);
    expect(n5.label).toContain("n5");
    expect(n5.envFileText("KEY123")).toBe("LLM_KEY=KEY123\nLISTEN=127.0.0.1:18020\n");
  });

  test("another node takes its own port and key, the node-side names unchanged", () => {
    const n2 = textModelService("n2");

    expect(n2.node).toBe("n2");
    expect(n2.serviceDir).toBe("n5-llm");
    expect(n2.units).toEqual(["n5-llm-front.service", "n5-llm-tunnel.service"]);
    expect(n2.listen).toBe("127.0.0.1:18021");
    expect(n2.keyPath().endsWith("env/n2-llm.token")).toBe(true);
    expect(n2.envFileText("K")).toBe("LLM_KEY=K\nLISTEN=127.0.0.1:18021\n");
  });

  test("the nodes, the base URLs and the key paths line up, and an unknown node is refused", () => {
    expect([...TEXT_NODES]).toEqual(["n5", "n2", "n3", "n4"]);
    expect(textBaseUrl("n3")).toBe("http://127.0.0.1:18023/v1");
    expect(textBaseUrl("n4")).toBe("http://127.0.0.1:18024/v1");
    expect(textKeyPath("n3").endsWith("env/n3-llm.token")).toBe(true);
    expect(() => textModelService("n7")).toThrow();
    expect(() => textBaseUrl("n6")).toThrow();
  });
});
