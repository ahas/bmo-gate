import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CARD_FILES, N5_FILES, TEXT_CARDS, TEXT_NODES, installTextCard, installTextModel, textBaseUrl, textKeyPath, textModelService } from "./n5-llm-install";
import { scratchDir } from "./scratch";

import type { NodeRunner, RunResult } from "./jake";

// What the text model answers the installs with: the head's files, settings, units, listen on
// main-host and place in the door's list through the shared tunnelled install, and a card node's own
// install. The shared steps themselves are checked through the Laya service in llm-install.test.ts.

const TUNNEL_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeN5TunnelKeyBody0123456789abcdefghij n5-llm-tunnel@n5";
const answer = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });

interface Seen {
  uploads: Array<{ local: string; remote: string; text: string | null }>;
  commands: string[];
}

function standIn(): { runner: NodeRunner; seen: Seen } {
  const seen: Seen = { uploads: [], commands: [] };
  const runner: NodeRunner = async (argv) => {
    if (argv[2] === "upload") {
      const local = argv[3]!;
      seen.uploads.push({ local, remote: argv[4]!, text: existsSync(local) ? readFileSync(local, "utf8") : null });
      return answer("");
    }
    const command = argv[5] ?? "";
    seen.commands.push(command);
    if (command.startsWith("echo HOME")) {
      return answer("HOME=/home/labuser\n");
    }
    if (command.includes("setup.log 2>/dev/null")) {
      return answer("N5-LLM-SETUP-DONE ok\n");
    }
    if (command.includes("ss -ltn")) {
      return answer("CARD-WAITING\n");
    }
    return answer(command.includes("ssh-keygen") ? `${TUNNEL_PUB}\n` : "launched\n");
  };
  return { runner, seen };
}

describe("the text model's head install", () => {
  test("carries its own files, its settings with the borrowed cards, and asks for its own listen and door entry", async () => {
    const root = scratchDir("bmo-n5-llm-install-");
    const hostKeyPath = join(root, "host.pub");
    writeFileSync(hostKeyPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHost root@main-host\n");
    mkdirSync(join(root, "tmp"));
    const keyPath = join(root, "data", "env", "n5-llm.token");
    const doorListPath = join(root, "data", "env", "tunnel-door.keys");
    const authorizedKeysPath = join(root, "home", ".ssh", "authorized_keys");
    const { runner, seen } = standIn();

    const outcome = await installTextModel("n5", {
      runner, console: "/jake/main.ts", checkout: "/checkout", keyPath, doorListPath, authorizedKeysPath, hostKeyPath,
      tmpRoot: join(root, "tmp"), local: async () => answer(""), health: async () => true, wait: async () => {}, setupPolls: 2,
    });

    expect(outcome.ok).toBe(true);
    expect(seen.commands[1]).toBe("mkdir -p ~/n5-llm/models ~/n5-llm/slots ~/.config/n5-llm && chmod 700 ~/.config/n5-llm");
    const key = readFileSync(keyPath, "utf8").trim();
    expect(seen.uploads[0]).toEqual({
      local: expect.any(String),
      remote: "/home/labuser/.config/n5-llm/env",
      text: `LLM_KEY=${key}\nLISTEN=127.0.0.1:18020\nN5_LLM_ROLE=head\n`
        + `N5_LLM_CARDS="192.0.2.17:18 192.0.2.18:18 192.0.2.19:18 192.0.2.21:4"\nN5_LLM_SHARE=8\nGGML_CUDA_FA_F16_MAX_KV=262144\n`,
    });
    expect(seen.uploads.slice(1, 2 + N5_FILES.length).map((one) => [one.local, one.remote])).toEqual([
      ...N5_FILES.map((name) => [`/checkout/n5-llm/${name}`, `/home/labuser/n5-llm/${name}`]),
      ["/checkout/llm-server/ws-dial.py", "/home/labuser/n5-llm/ws-dial.py"],
    ]);
    expect(seen.commands.at(-1)).toContain("systemctl --user enable n5-llm-front.service n5-llm-tunnel.service");
    expect(readFileSync(authorizedKeysPath, "utf8")).toContain('permitlisten="127.0.0.1:18020"');
    expect(readFileSync(doorListPath, "utf8")).toBe(`${keyPath}\n`);
  });
});

describe("a card node's install", () => {
  test("carries the head's key in its settings, its own files, and puts its holder in place of a head's units", async () => {
    const root = scratchDir("bmo-n5-llm-card-");
    mkdirSync(join(root, "tmp"));
    const keyPath = join(root, "data", "env", "n5-llm.token");
    const { runner, seen } = standIn();
    const n6 = TEXT_CARDS.find((card) => card.node === "n6")!;

    const outcome = await installTextCard(n6, {
      runner, console: "/jake/main.ts", checkout: "/checkout", keyPath, tmpRoot: join(root, "tmp"), wait: async () => {}, setupPolls: 2,
    });

    expect(outcome).toEqual({ ok: true, step: null, fault: null, done: ["key", "home", "env", "upload", "setup", "units", "waiting"] });
    const key = readFileSync(keyPath, "utf8").trim();
    // n6's card is shared outside the lock, so its holder takes none.
    expect(seen.uploads[0]!.text).toBe(`LLM_KEY=${key}\nN5_LLM_ROLE=card\nCARD_ADDRESS=192.0.2.21\nCARD_LOCK=\nGGML_CUDA_FA_F16_MAX_KV=262144\n`);
    expect(seen.uploads.slice(1).map((one) => one.remote)).toEqual(CARD_FILES.map((name) => `/home/labuser/n5-llm/${name}`));
    const units = seen.commands.find((command) => command.includes("n5-llm-card.service"))!;
    expect(units).toContain("systemctl --user disable --now n5-llm-front.service n5-llm-tunnel.service");
    expect(units).toContain("systemctl --user enable n5-llm-card.service && systemctl --user restart n5-llm-card.service");
  });

  test("a card on a node with the lock names it, and a holder that never waits stops the install there", async () => {
    const root = scratchDir("bmo-n5-llm-card-");
    mkdirSync(join(root, "tmp"));
    const { runner: answering, seen } = standIn();
    const runner: NodeRunner = async (argv, limit) =>
      (argv[5] ?? "").includes("ss -ltn") ? answer("failed\n") : answering(argv, limit);

    const outcome = await installTextCard(TEXT_CARDS[0]!, {
      runner, console: "/jake/main.ts", checkout: "/checkout", keyPath: join(root, "key"), tmpRoot: join(root, "tmp"), wait: async () => {}, setupPolls: 2,
    });

    expect(seen.uploads[0]!.text).toContain("CARD_ADDRESS=192.0.2.17\nCARD_LOCK=/home/labuser/.gpu.lock\n");
    expect(outcome.ok).toBe(false);
    expect(outcome.step).toBe("waiting");
  });
});

describe("the text model service factory", () => {
  test("the head answers alone, on n5's port with n5's key, and no other node is a text node", () => {
    const n5 = textModelService();

    expect([...TEXT_NODES]).toEqual(["n5"]);
    expect(n5.node).toBe("n5");
    expect(n5.serviceDir).toBe("n5-llm");
    expect(n5.configDir).toBe(".config/n5-llm");
    expect(n5.listen).toBe("127.0.0.1:18020");
    expect(n5.engineUnit).toBe("n5-llm-front");
    expect(n5.units).toEqual(["n5-llm-front.service", "n5-llm-tunnel.service"]);
    expect(textBaseUrl()).toBe("http://127.0.0.1:18020/v1");
    expect(textKeyPath().endsWith("env/n5-llm.token")).toBe(true);
    expect(() => textModelService("n2")).toThrow();
    expect(() => textBaseUrl("n6")).toThrow();
  });
});
