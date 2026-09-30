import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ENGINE_FILES, installLlmService, LAYA_SERVICE, SERVICE_FILES, TUNNEL_LISTEN } from "./llm-install";
import { scratchDir } from "./scratch";
import {
  authorizedLine,
  bridgeCommand,
  ensureAuthorized,
  keyMaterial,
  knownHostsLine,
  tunnelKeyCommand,
  type InstallOptions,
} from "./tunnel-install";

// The shared tunnelled install, run through the Laya service on n6. What another service answers
// differently is checked in that service's own test.

import type { NodeRunner, RunResult } from "./jake";

const CONSOLE = "/home/ahas/repos/ahas/jake/src/console/main.ts";
const TUNNEL_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeTunnelKeyBody0123456789abcdefghijk bmo-llm-tunnel@n6";
const HOST_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyBody9876543210zyxwvutsrqpo root@main-host\n";

const answer = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

interface Seen {
  argv: string[];
  /** What an uploaded file held and its mode, read the moment it was handed over. */
  carried?: { text: string; mode: number };
}

function fakeNode(options: { setup?: string; keyAnswer?: RunResult } = {}): { runner: NodeRunner; seen: Seen[] } {
  const seen: Seen[] = [];
  const runner: NodeRunner = async (argv) => {
    const one: Seen = { argv: [...argv] };
    seen.push(one);
    const verb = argv[2];

    if (verb === "upload") {
      const local = argv[3]!;
      if (existsSync(local)) {
        one.carried = { text: readFileSync(local, "utf8"), mode: statSync(local).mode & 0o777 };
      }
      return answer("");
    }

    const command = argv[5] ?? "";
    if (command.startsWith("echo HOME")) {
      return answer("HOME=/home/labuser\n");
    }
    if (command.includes("setsid nohup")) {
      return answer("launched\n");
    }
    if (command.includes("setup.log")) {
      return answer(`[10:00] installing what pyproject pins\n${options.setup ?? "LLM-SETUP-DONE ok"}\n`);
    }
    if (command.includes("ssh-keygen")) {
      return options.keyAnswer ?? answer(`${TUNNEL_PUB}\n`);
    }

    return answer("");
  };

  return { runner, seen };
}

interface Stage {
  root: string;
  keyPath: string;
  doorListPath: string;
  authorizedKeysPath: string;
  hostKeyPath: string;
  said: string[];
  // The commands the install ran on main-host itself.
  local: string[];
}

function stage(): Stage {
  const root = scratchDir("bmo-llm-install-");
  const hostKeyPath = join(root, "ssh_host_ed25519_key.pub");
  writeFileSync(hostKeyPath, HOST_PUB);

  return {
    root,
    keyPath: join(root, "data", "env", "laya.token"),
    doorListPath: join(root, "data", "env", "tunnel-door.keys"),
    authorizedKeysPath: join(root, "home", ".ssh", "authorized_keys"),
    hostKeyPath,
    said: [],
    local: [],
  };
}

function installing(runner: NodeRunner, at: Stage, changes: Partial<InstallOptions> = {}): InstallOptions {
  mkdirSync(join(at.root, "tmp"), { recursive: true });
  return {
    runner,
    console: CONSOLE,
    keyPath: at.keyPath,
    doorListPath: at.doorListPath,
    authorizedKeysPath: at.authorizedKeysPath,
    hostKeyPath: at.hostKeyPath,
    tmpRoot: join(at.root, "tmp"),
    // main-host's own commands, which in a test run nothing: the bridge unit is only named.
    local: async (argv) => {
      at.local.push(argv.at(-1) ?? "");
      return { code: 0, stdout: "", stderr: "" };
    },
    checkout: "/checkout",
    health: async () => true,
    wait: async () => {},
    setupPolls: 3,
    healthPolls: 2,
    say: (line) => at.said.push(line),
    ...changes,
  };
}

const commandOf = (one: Seen) => (one.argv[2] === "upload" ? `upload ${one.argv[4]}` : one.argv[5] ?? "");

describe("the pieces the install writes", () => {
  test("the tunnel's entry allows one forward and no shell", () => {
    expect(authorizedLine("ssh-ed25519 AAAA", TUNNEL_LISTEN)).toBe(
      'restrict,port-forwarding,permitlisten="127.0.0.1:18010",command="/usr/sbin/nologin" ssh-ed25519 AAAA',
    );
  });

  test("a key is known by its type and body, not its comment or options", () => {
    expect(keyMaterial(TUNNEL_PUB)).toBe(TUNNEL_PUB.split(" ").slice(0, 2).join(" "));
    expect(keyMaterial(authorizedLine(TUNNEL_PUB, TUNNEL_LISTEN))).toBe(keyMaterial(TUNNEL_PUB));
    expect(keyMaterial("no key here")).toBeNull();
  });

  test("main-host's host key is pinned under the name the tunnel's ssh knows it by", () => {
    expect(knownHostsLine(HOST_PUB)).toBe(`main-host ${keyMaterial(HOST_PUB)}`);
  });

  test("the bridge unit is linked from the checkout, and restarted so an update takes effect", () => {
    const command = bridgeCommand("/checkout");
    expect(command).toContain("ln -sfn /checkout/bmo-llm-bridge.service ~/.config/systemd/user/bmo-llm-bridge.service");
    expect(command.endsWith("systemctl --user enable bmo-llm-bridge.service && systemctl --user restart bmo-llm-bridge.service")).toBe(true);
  });

  test("the tunnel key is made only where there is none, and only its public half is read back", () => {
    const command = tunnelKeyCommand(LAYA_SERVICE);
    expect(command).toContain("-C bmo-llm-tunnel@n6");
    expect(command.startsWith("test -f ~/.config/bmo-llm/tunnel_ed25519 || ssh-keygen")).toBe(true);
    expect(command.endsWith("cat ~/.config/bmo-llm/tunnel_ed25519.pub")).toBe(true);
  });
});

describe("the whole install", () => {
  test("runs its steps in order and keeps the key out of every command and every line", async () => {
    const at = stage();
    const { runner, seen } = fakeNode();

    const outcome = await installLlmService(installing(runner, at));

    expect(outcome).toEqual({
      ok: true, step: null, fault: null,
      done: ["key", "home", "env", "upload", "setup", "tunnel-key", "authorized-keys", "bridge", "known-hosts", "units", "health"],
    });

    const commands = seen.map(commandOf);
    const at_ = (what: string) => commands.findIndex((command) => command.includes(what));
    expect(at_("echo HOME")).toBe(0);
    expect(at_("mkdir -p ~/bmo-llm ~/bmo-laya ~/.config/bmo-llm ~/.config/bmo-laya")).toBe(1);
    // The gates' settings file is made only where none stands, so a gate named there is never lost.
    expect(commands[1]).toContain(`test -f ~/.config/bmo-laya/env || printf 'LAYA_CHECKPOINTS=""\\n' > ~/.config/bmo-laya/env`);
    expect(commands[2]).toBe("upload /home/labuser/.config/bmo-llm/env");
    expect(commands[3]).toBe("chmod 600 ~/.config/bmo-llm/env");
    const uploads = SERVICE_FILES.length + ENGINE_FILES.length;
    expect(commands.slice(4, 4 + uploads)).toEqual([
      ...SERVICE_FILES.map((name) => `upload /home/labuser/bmo-llm/${name}`),
      ...ENGINE_FILES.map((name) => `upload /home/labuser/bmo-laya/${name}`),
    ]);
    expect(seen[4 + SERVICE_FILES.length]!.argv[3]).toBe("/checkout/laya-server/server.py");
    expect(at_("setsid nohup bash node-setup.sh")).toBeLessThan(at_("setup.log 2>/dev/null"));
    expect(at_("setup.log 2>/dev/null")).toBeLessThan(at_("ssh-keygen"));
    expect(at_("ssh-keygen")).toBeLessThan(at_("upload /home/labuser/.config/bmo-llm/known_hosts"));
    expect(at_("upload /home/labuser/.config/bmo-llm/known_hosts")).toBeLessThan(at_("systemctl --user daemon-reload"));
    expect(commands.at(-1)).toContain("systemctl --user enable bmo-llm-laya.service bmo-llm-front.service bmo-llm-tunnel.service");

    const key = readFileSync(at.keyPath, "utf8").trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(at.keyPath).mode & 0o777).toBe(0o600);
    for (const one of seen) {
      expect(one.argv.join(" ")).not.toContain(key);
    }
    for (const line of at.said) {
      expect(line).not.toContain(key);
    }

    // The key travelled only inside the environment file, which was private and is gone again.
    const env = seen.find((one) => one.argv[4]?.endsWith("/.config/bmo-llm/env"))!.carried!;
    expect(env.mode).toBe(0o600);
    expect(env.text).toBe(`LLM_KEY=${key}\nLAYA_TOKEN=${key}\n`);
    expect(readdirSync(join(at.root, "tmp"))).toEqual([]);

    const pinned = seen.find((one) => one.argv[4]?.endsWith("/known_hosts"))!.carried!;
    expect(pinned.text).toBe(`${knownHostsLine(HOST_PUB)}\n`);

    expect(readFileSync(at.authorizedKeysPath, "utf8")).toBe(`${authorizedLine(keyMaterial(TUNNEL_PUB)!, TUNNEL_LISTEN)}\n`);
    expect(statSync(at.authorizedKeysPath).mode & 0o777).toBe(0o600);

    // The door takes the tunnel by the key's file, named once in its list.
    expect(readFileSync(at.doorListPath, "utf8")).toBe(`${at.keyPath}\n`);
  });

  test("a key already made and an entry already standing are left as they are", async () => {
    const at = stage();
    const key = "ab".repeat(32);
    mkdirSync(join(at.root, "data", "env"), { recursive: true });
    writeFileSync(at.keyPath, `${key}\n`, { mode: 0o600 });
    mkdirSync(join(at.root, "home", ".ssh"), { recursive: true });
    const standing = `ssh-ed25519 AAAAotherKey someone@else\nrestrict,port-forwarding ${keyMaterial(TUNNEL_PUB)} an-older-comment\n`;
    writeFileSync(at.authorizedKeysPath, standing, { mode: 0o600 });
    const { runner, seen } = fakeNode();

    const outcome = await installLlmService(installing(runner, at));

    expect(outcome.ok).toBe(true);
    expect(readFileSync(at.keyPath, "utf8")).toBe(`${key}\n`);
    expect(readFileSync(at.authorizedKeysPath, "utf8")).toBe(standing);
    expect(seen.find((one) => one.argv[4]?.endsWith("/.config/bmo-llm/env"))!.carried!.text).toContain(`LLM_KEY=${key}\n`);
    expect(at.said).toContain("서비스 키는 이미 있어요");
  });

  test("a key file anyone else could read is refused before anything reaches the node", async () => {
    const at = stage();
    mkdirSync(join(at.root, "data", "env"), { recursive: true });
    writeFileSync(at.keyPath, `${"cd".repeat(32)}\n`, { mode: 0o644 });
    const { runner, seen } = fakeNode();

    const outcome = await installLlmService(installing(runner, at));

    expect(outcome.ok).toBe(false);
    expect(outcome.step).toBe("key");
    expect(outcome.fault).toContain("0600");
    expect(seen).toEqual([]);
  });

  test("a setup that broke names the step and goes no further", async () => {
    const at = stage();
    const { runner, seen } = fakeNode({ setup: "LLM-SETUP-DONE failed:install" });

    const outcome = await installLlmService(installing(runner, at));

    expect(outcome.ok).toBe(false);
    expect(outcome.step).toBe("setup");
    expect(outcome.fault).toContain("install");
    expect(outcome.fault).toContain("setup.log");
    expect(outcome.done).toEqual(["key", "home", "env", "upload"]);
    expect(seen.some((one) => (one.argv[5] ?? "").includes("ssh-keygen"))).toBe(false);
    expect(seen.some((one) => (one.argv[5] ?? "").includes("systemctl"))).toBe(false);
    expect(existsSync(at.authorizedKeysPath)).toBe(false);
  });

  test("a setup that never finishes is not waited on for ever", async () => {
    const at = stage();
    const { runner } = fakeNode({ setup: "[10:05] setting up the engine" });

    const outcome = await installLlmService(installing(runner, at));

    expect(outcome.step).toBe("setup");
    expect(outcome.fault).toContain("끝나지 않았어요");
  });

  test("a bridge that does not come up stops the install before the node's units are touched", async () => {
    const at = stage();
    const { runner, seen } = fakeNode();

    const outcome = await installLlmService(installing(runner, at, { local: async () => ({ code: 1, stdout: "", stderr: "Unit not found" }) }));

    expect(outcome.step).toBe("bridge");
    expect(outcome.fault).toContain("bmo-llm-bridge.service");
    expect(outcome.done.at(-1)).toBe("authorized-keys");
    expect(seen.map(commandOf).some((command) => command.includes("systemctl"))).toBe(false);
  });

  test("a service that never answers through the tunnel is said so, with where to look", async () => {
    const at = stage();
    const { runner } = fakeNode();

    const outcome = await installLlmService(installing(runner, at, { health: async () => false }));

    expect(outcome.step).toBe("health");
    expect(outcome.fault).toContain("http://127.0.0.1:18010/health");
    expect(outcome.done.at(-1)).toBe("units");
  });

  test("an entry for a second key is added beside what stands, not over it", () => {
    const at = stage();
    mkdirSync(join(at.root, "home", ".ssh"), { recursive: true });
    writeFileSync(at.authorizedKeysPath, "ssh-ed25519 AAAAotherKey someone@else", { mode: 0o600 });

    expect(ensureAuthorized(at.authorizedKeysPath, TUNNEL_PUB, TUNNEL_LISTEN)).toBe("added");
    expect(readFileSync(at.authorizedKeysPath, "utf8"))
      .toBe(`ssh-ed25519 AAAAotherKey someone@else\n${authorizedLine(keyMaterial(TUNNEL_PUB)!, TUNNEL_LISTEN)}\n`);
    expect(ensureAuthorized(at.authorizedKeysPath, TUNNEL_PUB, TUNNEL_LISTEN)).toBe("already there");
  });
});
