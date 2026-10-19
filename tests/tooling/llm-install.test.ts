import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkpointStoreCommand,
  ENGINE_FILES,
  installLlmService,
  LAYA_SERVICE_PLACEMENT,
  layaService,
  RETIRED_WATCH_UNIT,
  SERVICE_FILES,
} from "../../training/tooling/src/llm-install";
import { PlacementFault } from "../../training/tooling/src/placement";
import { scratchDir } from "./scratch";
import {
  authorizedLine,
  ensureAuthorized,
  keyMaterial,
  knownHostsLine,
  installTunnelledService,
  tunnelKeyCommand,
  unitsCommand,
  type InstallOptions,
  type TunnelEnds,
} from "../../training/tooling/src/tunnel-install";

// The shared tunnelled install, run through the Laya service on a made-up node, echo. What another service answers
// differently is checked in that service's own test.

import type { NodeRunner, RunResult } from "../../training/tooling/src/node-calls";
import type { ServiceNode } from "../../training/tooling/src/llm-install";
import type { Machine } from "../../training/tooling/src/machine";

const ECHO: ServiceNode = { node: "echo", listen: "127.0.0.1:18011", cardModels: null, hostCopy: null };
const LINUX: Machine = { wsl: false, card: { name: "NVIDIA GeForce RTX 4070", totalMiB: 12282 } };
const DESKTOP: Machine = { wsl: true, card: { name: "NVIDIA GeForce RTX 3080", totalMiB: 10240 } };

/** The shared tunnelled install of the service alone, on a machine read beforehand. */
const installService = (at: ServiceNode, options: InstallOptions) => installTunnelledService(layaService(at, LINUX), options);

const CONSOLE = "/opt/console/main.ts";
const TUNNEL: TunnelEnds = { url: "wss://tunnel.example.test", login: "operator@127.0.0.1", host: "operations" };
const TUNNEL_TEXT = "TUNNEL_URL=wss://tunnel.example.test\nTUNNEL_LOGIN=operator@127.0.0.1\nTUNNEL_HOST=operations\n";
const TUNNEL_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeTunnelKeyBody0123456789abcdefghijk bmo-llm-tunnel@echo";
const HOST_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyBody9876543210zyxwvutsrqpo root@operations\n";

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
      return answer("HOME=/srv/trainer\n");
    }
    if (command.includes("setsid nohup")) {
      return answer("launched\n");
    }
    if (command.includes("bmo-card/setup.log")) {
      return answer("[10:00] installing what pyproject pins\nCARD-SETUP-DONE ok\n");
    }
    if (command.includes("units.store")) {
      return answer("STORE 148\n");
    }
    if (command.includes("setup.log")) {
      return answer(`[10:00] installing what pyproject pins\n${options.setup ?? "LLM-SETUP-DONE ok"}\n`);
    }
    if (command.includes("MACHINE_WSL")) {
      return answer("MACHINE_WSL=1\nMACHINE_CARD_MIB=10240\nMACHINE_CARD_NAME=NVIDIA GeForce RTX 3080\n");
    }
    if (command.includes("MainPID")) {
      return answer("4242\n");
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
    checkout: "/checkout",
    tunnel: TUNNEL,
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
    expect(authorizedLine("ssh-ed25519 AAAA", ECHO.listen)).toBe(
      'restrict,port-forwarding,permitlisten="127.0.0.1:18011",command="/usr/sbin/nologin" ssh-ed25519 AAAA',
    );
  });

  test("a key is known by its type and body, not its comment or options", () => {
    expect(keyMaterial(TUNNEL_PUB)).toBe(TUNNEL_PUB.split(" ").slice(0, 2).join(" "));
    expect(keyMaterial(authorizedLine(TUNNEL_PUB, ECHO.listen))).toBe(keyMaterial(TUNNEL_PUB));
    expect(keyMaterial("no key here")).toBeNull();
  });

  test("the operations machine's host key is pinned under the name the tunnel's ssh knows it by", () => {
    expect(knownHostsLine(HOST_PUB, "operations")).toBe(`operations ${keyMaterial(HOST_PUB)}`);
  });

  test("the tunnel key is made only where there is none, and only its public half is read back", () => {
    const command = tunnelKeyCommand(layaService(ECHO, LINUX));
    expect(command).toContain("-C bmo-llm-tunnel@echo");
    expect(command.startsWith("test -f ~/.config/bmo-llm/tunnel_ed25519 || ssh-keygen")).toBe(true);
    expect(command.endsWith("cat ~/.config/bmo-llm/tunnel_ed25519.pub")).toBe(true);
  });
});

describe("the whole install", () => {
  test("runs its steps in order and keeps the key out of every command and every line", async () => {
    const at = stage();
    const { runner, seen } = fakeNode();

    const outcome = await installService(ECHO, installing(runner, at));

    expect(outcome).toEqual({
      ok: true, step: null, fault: null,
      done: ["key", "home", "env", "upload", "setup", "tunnel-key", "authorized-keys", "door", "known-hosts", "units", "health"],
    });

    const commands = seen.map(commandOf);
    const at_ = (what: string) => commands.findIndex((command) => command.includes(what));
    expect(at_("echo HOME")).toBe(0);
    expect(at_("mkdir -p ~/bmo-llm ~/bmo-laya ~/.config/bmo-llm ~/.config/bmo-laya")).toBe(1);
    // The gates' settings file is made only where none stands, so a gate named there is never lost.
    expect(commands[1]).toContain(`test -f ~/.config/bmo-laya/env || printf 'LAYA_CHECKPOINTS=""\\n' > ~/.config/bmo-laya/env`);
    expect(commands[2]).toBe("upload /srv/trainer/.config/bmo-llm/env");
    expect(commands[3]).toBe("chmod 600 ~/.config/bmo-llm/env");
    const uploads = SERVICE_FILES.length + ENGINE_FILES.length;
    expect(commands.slice(4, 4 + uploads)).toEqual([
      ...SERVICE_FILES.map((name) => `upload /srv/trainer/bmo-llm/${name}`),
      ...ENGINE_FILES.map((name) => `upload /srv/trainer/bmo-laya/${name}`),
    ]);
    expect(seen[4 + SERVICE_FILES.length]!.argv[3]).toBe("/checkout/runtime/laya-server/server.py");
    expect(seen[4]!.argv[3]).toBe("/checkout/runtime/front/front.py");
    expect(at_("setsid nohup bash node-setup.sh")).toBeLessThan(at_("setup.log 2>/dev/null"));
    expect(at_("setup.log 2>/dev/null")).toBeLessThan(at_("ssh-keygen"));
    expect(at_("ssh-keygen")).toBeLessThan(at_("upload /srv/trainer/.config/bmo-llm/known_hosts"));
    expect(at_("upload /srv/trainer/.config/bmo-llm/known_hosts")).toBeLessThan(at_("systemctl --user daemon-reload"));
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
    expect(env.text).toBe(`LLM_KEY=${key}\nLAYA_TOKEN=${key}\nTUNNEL_LISTEN=127.0.0.1:18011\n${TUNNEL_TEXT}`);
    expect(readdirSync(join(at.root, "tmp"))).toEqual([]);

    const pinned = seen.find((one) => one.argv[4]?.endsWith("/known_hosts"))!.carried!;
    expect(pinned.text).toBe(`${knownHostsLine(HOST_PUB, TUNNEL.host)}\n`);

    expect(readFileSync(at.authorizedKeysPath, "utf8")).toBe(`${authorizedLine(keyMaterial(TUNNEL_PUB)!, ECHO.listen)}\n`);
    expect(statSync(at.authorizedKeysPath).mode & 0o777).toBe(0o600);

    // The door takes the tunnel by the key's file, named once in its list, and is itself left alone.
    expect(readFileSync(at.doorListPath, "utf8")).toBe(`${at.keyPath}\n`);
    expect(at.said).toContain("the key was named in the door's list");
  });

  test("a key already made is left as it is, and the standing entry of its tunnel key is brought to the one form", async () => {
    const at = stage();
    const key = "ab".repeat(32);
    mkdirSync(join(at.root, "data", "env"), { recursive: true });
    writeFileSync(at.keyPath, `${key}\n`, { mode: 0o600 });
    mkdirSync(join(at.root, "home", ".ssh"), { recursive: true });
    const standing = `ssh-ed25519 AAAAotherKey someone@else\nrestrict,port-forwarding ${keyMaterial(TUNNEL_PUB)} an-older-comment\n`;
    writeFileSync(at.authorizedKeysPath, standing, { mode: 0o600 });
    const { runner, seen } = fakeNode();

    const outcome = await installService(ECHO, installing(runner, at));

    expect(outcome.ok).toBe(true);
    expect(readFileSync(at.keyPath, "utf8")).toBe(`${key}\n`);
    expect(readFileSync(at.authorizedKeysPath, "utf8"))
      .toBe(`ssh-ed25519 AAAAotherKey someone@else\n${authorizedLine(keyMaterial(TUNNEL_PUB)!, ECHO.listen)}\n`);
    expect(seen.find((one) => one.argv[4]?.endsWith("/.config/bmo-llm/env"))!.carried!.text).toContain(`LLM_KEY=${key}\n`);
    expect(at.said).toContain("the service key stands already");
  });

  test("a key file anyone else could read is refused before anything reaches the node", async () => {
    const at = stage();
    mkdirSync(join(at.root, "data", "env"), { recursive: true });
    writeFileSync(at.keyPath, `${"cd".repeat(32)}\n`, { mode: 0o644 });
    const { runner, seen } = fakeNode();

    const outcome = await installService(ECHO, installing(runner, at));

    expect(outcome.ok).toBe(false);
    expect(outcome.step).toBe("key");
    expect(outcome.fault).toContain("0600");
    expect(seen).toEqual([]);
  });

  test("a setup that broke names the step and goes no further", async () => {
    const at = stage();
    const { runner, seen } = fakeNode({ setup: "LLM-SETUP-DONE failed:install" });

    const outcome = await installService(ECHO, installing(runner, at));

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

    const outcome = await installService(ECHO, installing(runner, at));

    expect(outcome.step).toBe("setup");
    expect(outcome.fault).toContain("did not finish");
  });

  test("a service that never answers through the tunnel is said so, with where to look", async () => {
    const at = stage();
    const { runner } = fakeNode();

    const outcome = await installService(ECHO, installing(runner, at, { health: async () => false }));

    expect(outcome.step).toBe("health");
    expect(outcome.fault).toContain("http://127.0.0.1:18011/health");
    expect(outcome.done.at(-1)).toBe("units");
  });

  test("an entry for a second key is added beside what stands, not over it", () => {
    const at = stage();
    mkdirSync(join(at.root, "home", ".ssh"), { recursive: true });
    writeFileSync(at.authorizedKeysPath, "ssh-ed25519 AAAAotherKey someone@else", { mode: 0o600 });

    expect(ensureAuthorized(at.authorizedKeysPath, TUNNEL_PUB, ECHO.listen)).toBe("added");
    expect(readFileSync(at.authorizedKeysPath, "utf8"))
      .toBe(`ssh-ed25519 AAAAotherKey someone@else\n${authorizedLine(keyMaterial(TUNNEL_PUB)!, ECHO.listen)}\n`);
    expect(ensureAuthorized(at.authorizedKeysPath, TUNNEL_PUB, ECHO.listen)).toBe("already there");
  });

  test("a key moved to another listen has its own entry rewritten, and every other line kept", () => {
    const at = stage();
    mkdirSync(join(at.root, "home", ".ssh"), { recursive: true });
    const other = "ssh-ed25519 AAAAotherKey someone@else";
    writeFileSync(at.authorizedKeysPath, `${other}\n${authorizedLine(keyMaterial(TUNNEL_PUB)!, "127.0.0.1:18010")}\n`, { mode: 0o600 });

    expect(ensureAuthorized(at.authorizedKeysPath, TUNNEL_PUB, ECHO.listen)).toBe("rewritten");
    expect(readFileSync(at.authorizedKeysPath, "utf8")).toBe(`${other}\n${authorizedLine(keyMaterial(TUNNEL_PUB)!, ECHO.listen)}\n`);
    expect(statSync(at.authorizedKeysPath).mode & 0o777).toBe(0o600);
  });
});

describe("the service, written for its machine", () => {
  test("the service is written for the machine it read, and stands no card arbiter of its own", async () => {
    const at = stage();
    const { runner, seen } = fakeNode();

    const outcome = await installLlmService(ECHO, { ...installing(runner, at), role: null });

    expect(outcome.ok).toBe(true);
    expect(outcome.done[0]).toBe("machine");
    const commands = seen.map(commandOf);
    // The arbiter is the card master's to stand: none of its files and none of its settings go across here.
    expect(commands.some((command) => command.startsWith("upload /srv/trainer/bmo-card/"))).toBe(false);
    expect(seen.some((one) => one.argv[4]?.endsWith("/.config/bmo-card/env"))).toBe(false);
    // The fake machine is a WSL desktop, so the engine is told to keep its copies mapped and leave the desktop room.
    const env = seen.find((one) => one.argv[4]?.endsWith("/.config/bmo-llm/env"))!.carried!;
    expect(env.text).toContain("LAYA_HOST_COPY=mapped\nLAYA_CARD_KEEP_FREE_MIB=2048\n");
  });

  test("a node reserved for another service is refused before anything reaches it", async () => {
    const at = stage();
    const { runner, seen } = fakeNode();

    const outcome = await installLlmService({ ...ECHO, node: "bravo" }, { ...installing(runner, at), role: "engine" });

    expect(outcome).toEqual({ ok: false, step: "machine", fault: "bravo is reserved for engine in the node list, so laya may not stand on it", done: [] });
    expect(seen).toEqual([]);
  });
});

describe("a node of the service", () => {
  test("the card's watch the arbiter replaced is stopped wherever it still stands", () => {
    const units = unitsCommand(layaService(ECHO, LINUX));
    expect(units).toContain("systemctl --user enable bmo-llm-laya.service bmo-llm-front.service bmo-llm-tunnel.service &&");
    expect(units).toContain(`systemctl --user disable --now ${RETIRED_WATCH_UNIT}`);
  });

  test("the placement reads the nodes in their order, each with its listen", () => {
    expect(LAYA_SERVICE_PLACEMENT.read({
      nodes: [{ node: "office-pc", listen: "127.0.0.1:18011", cardModels: 2 }, { node: "foxtrot", listen: "127.0.0.1:18012", hostCopy: "mapped" }],
    })).toEqual([
      { node: "office-pc", listen: "127.0.0.1:18011", cardModels: 2, hostCopy: null },
      { node: "foxtrot", listen: "127.0.0.1:18012", cardModels: null, hostCopy: "mapped" },
    ]);
  });

  test("a node's bound on its card reaches the engine through that node's environment file alone", () => {
    expect(layaService({ ...ECHO, cardModels: 2 }, LINUX).envFileText("k")).toBe("LLM_KEY=k\nLAYA_TOKEN=k\nTUNNEL_LISTEN=127.0.0.1:18011\nLAYA_CARD_MODELS=2\n");
    expect(layaService(ECHO, LINUX).envFileText("k")).not.toContain("LAYA_CARD_MODELS");
    expect(layaService(ECHO, DESKTOP).envFileText("k")).toBe("LLM_KEY=k\nLAYA_TOKEN=k\nTUNNEL_LISTEN=127.0.0.1:18011\nLAYA_HOST_COPY=mapped\nLAYA_CARD_KEEP_FREE_MIB=2048\n");
  });

  test("a host copy the placement entry names stands over the machine's either way", () => {
    expect(layaService({ ...ECHO, hostCopy: "mapped" }, LINUX).envFileText("k")).toBe("LLM_KEY=k\nLAYA_TOKEN=k\nTUNNEL_LISTEN=127.0.0.1:18011\nLAYA_HOST_COPY=mapped\n");
    expect(layaService({ ...ECHO, hostCopy: "pinned" }, DESKTOP).envFileText("k")).toBe("LLM_KEY=k\nLAYA_TOKEN=k\nTUNNEL_LISTEN=127.0.0.1:18011\nLAYA_HOST_COPY=pinned\nLAYA_CARD_KEEP_FREE_MIB=2048\n");
  });

  test("the checkpoints stand outside the installation, the engine's folder linking to them", () => {
    const command = checkpointStoreCommand();
    expect(command.startsWith("mkdir -p ~/.local/share/bmo-laya/checkpoints && ")).toBe(true);
    expect(command).toContain("if [ -d ~/bmo-laya/checkpoints ] && [ ! -L ~/bmo-laya/checkpoints ]; then "
      + "if rmdir ~/.local/share/bmo-laya/checkpoints 2>/dev/null; then mv ~/bmo-laya/checkpoints ~/.local/share/bmo-laya/checkpoints; "
      + "else cp -a -n ~/bmo-laya/checkpoints/. ~/.local/share/bmo-laya/checkpoints/ && rm -rf ~/bmo-laya/checkpoints; fi; fi;");
    expect(command.endsWith("ln -sfn ~/.local/share/bmo-laya/checkpoints ~/bmo-laya/checkpoints")).toBe(true);
    expect(layaService(ECHO, LINUX).makeDirsCommand()).toContain(command);
  });

  test("a placement the relay could not ask is refused", () => {
    for (const value of [
      { node: "foxtrot" },
      { nodes: [] },
      { nodes: [{ node: "foxtrot" }] },
      { nodes: [{ node: "foxtrot", listen: "0.0.0.0:18012" }] },
      { nodes: [{ node: "foxtrot", listen: "127.0.0.1:18010" }] },
      { nodes: [{ node: "foxtrot", listen: "127.0.0.1:18012", cardModels: 0 }] },
      { nodes: [{ node: "foxtrot", listen: "127.0.0.1:18012", hostCopy: "swapped" }] },
      { nodes: [{ node: "a", listen: "127.0.0.1:18011" }, { node: "a", listen: "127.0.0.1:18012" }] },
      { nodes: [{ node: "a", listen: "127.0.0.1:18011" }, { node: "b", listen: "127.0.0.1:18011" }] },
    ]) {
      expect(() => LAYA_SERVICE_PLACEMENT.read(value)).toThrow(PlacementFault);
    }
  });
});
