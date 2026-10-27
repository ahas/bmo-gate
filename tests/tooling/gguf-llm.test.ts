import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ENGINE,
  GgufRefused,
  installGguf,
  instanceOf,
  parseEntry,
  parseGgufSettings,
  plannedFiles,
  renderUnits,
  uninstallGguf,
  writePlanned,
  type GgufInstance,
  type GgufOptions,
  type GgufSettings,
} from "../../training/tooling/src/gguf-llm";
import { authorizedLine, keyMaterial, knownHostsLine, type TunnelEnds } from "../../training/tooling/src/tunnel-install";
import { scratchDir } from "./scratch";

import type { NodeRunner, RunResult } from "../../training/tooling/src/node-calls";

// The GGUF engine's installer on a made-up node, echo, serving a made-up entry through a made-up catalogue
// verb. The shared tunnelled install's own steps are checked in llm-install's test; what is the GGUF
// engine's own is checked here.

const REPOSITORY = join(import.meta.dir, "..", "..");
const CONSOLE = "/opt/console/main.ts";
const CATALOGUE = "/opt/agency/bin/catalogue";
const TUNNEL: TunnelEnds = { url: "wss://tunnel.example.test", login: "operator@operations", host: "operations" };
const TUNNEL_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeTunnelKeyBody0123456789abcdefghijk echo-model-tunnel@echo";
const HOST_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyBody9876543210zyxwvutsrqpo root@operations\n";
const SHA = "0f".repeat(32);

const SETTINGS = `catalogue_command = ["${CATALOGUE}", "model"]

[nodes.echo]
llama_server = "engine/build/bin/llama-server"
dial_python = "engine/.venv/bin/python"
dial_script = "engine/ws-dial.py"

[registrations.echo-model-7b]
name = "echo-model"
node = "echo"
listen = "127.0.0.1:18051"
port = 8051
context = 16384
parallel = 2
slot_context = 8192
cache_type = "q8_0"
gpu_layers = 99
flash_attn = "on"
flags = ["--jinja", "--repeat-penalty", "1.05", "--no-webui"]
`;

const ENTRY = {
  name: "echo-model-q8", label: "Echo Model 7B Q8_0", file: "Echo-Model-7B-Q8_0.gguf", bytes: 7_000_000_000, sha256: SHA,
  source: "https://models.example.test/Echo-Model-7B-Q8_0.gguf", engine: ENGINE, registration: "echo-model-7b", nodes: [],
  thinking: null, temperature: 0.7, topP: null, presencePenalty: null, maxTokens: null, note: null,
};

const settings = (): GgufSettings => parseGgufSettings(SETTINGS, "gguf-llm.toml");
const instance = (changes: Record<string, unknown> = {}): GgufInstance =>
  instanceOf(parseEntry(JSON.stringify({ ...ENTRY, ...changes })), settings(), "gguf-llm.toml");

const answer = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

interface Seen {
  argv: string[];
  carried?: { text: string; mode: number };
}

function fakeNode(options: { setup?: string; placed?: RunResult } = {}): { runner: NodeRunner; seen: Seen[] } {
  const seen: Seen[] = [];
  const runner: NodeRunner = async (argv) => {
    const one: Seen = { argv: [...argv] };
    seen.push(one);

    if (argv[0] === CATALOGUE) {
      return options.placed ?? answer("");
    }
    if (argv[2] === "upload") {
      const local = argv[3]!;
      if (existsSync(local)) {
        one.carried = { text: readFileSync(local, "utf8"), mode: statSync(local).mode & 0o777 };
      }
      return answer("");
    }
    const command = argv[5] ?? "";
    if (command.startsWith("echo HOME")) {
      return answer("HOME=/srv/node\n");
    }
    if (command.includes("setsid nohup")) {
      return answer("launched\n");
    }
    if (command.includes("setup.log")) {
      return answer(`[10:00] checking Echo-Model-7B-Q8_0.gguf\n${options.setup ?? "GGUF-LLM-SETUP-DONE ok"}\n`);
    }
    if (command.includes("ssh-keygen") || command.startsWith("cat ~/.config/echo-model/tunnel_ed25519.pub")) {
      return answer(`${TUNNEL_PUB}\n`);
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
  const root = scratchDir("bmo-gguf-llm-");
  const hostKeyPath = join(root, "ssh_host_ed25519_key.pub");
  writeFileSync(hostKeyPath, HOST_PUB);
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.BMO_DATA_DIR = join(root, "data");

  return {
    root,
    keyPath: join(root, "data", "env", "echo-model.token"),
    doorListPath: join(root, "data", "env", "tunnel-door.keys"),
    authorizedKeysPath: join(root, "home", ".ssh", "authorized_keys"),
    hostKeyPath,
    said: [],
  };
}

function installing(runner: NodeRunner, at: Stage, role: string | null = null): GgufOptions {
  return {
    runner,
    console: CONSOLE,
    role,
    settings: settings(),
    keyPath: at.keyPath,
    doorListPath: at.doorListPath,
    authorizedKeysPath: at.authorizedKeysPath,
    hostKeyPath: at.hostKeyPath,
    tmpRoot: join(at.root, "tmp"),
    checkout: REPOSITORY,
    tunnel: TUNNEL,
    health: async () => true,
    wait: async () => {},
    setupPolls: 3,
    healthPolls: 2,
    say: (line) => at.said.push(line),
  };
}

const commandOf = (one: Seen) => (one.argv[2] === "upload" ? `upload ${one.argv[4]}` : one.argv.length > 5 ? one.argv[5]! : one.argv.join(" "));

describe("the settings", () => {
  test("give each node's tools and each registration's serving", () => {
    const read = settings();
    expect(read.catalogue).toEqual([CATALOGUE, "model"]);
    expect(read.nodes.echo).toEqual({
      llamaServer: "engine/build/bin/llama-server", dialPython: "engine/.venv/bin/python", dialScript: "engine/ws-dial.py",
    });
    expect(read.registrations["echo-model-7b"]).toEqual({
      registration: "echo-model-7b", name: "echo-model", node: "echo", listen: "127.0.0.1:18051", port: 8051, context: 16384,
      parallel: 2, slotContext: 8192, cacheType: "q8_0", gpuLayers: 99, flashAttn: "on", flags: ["--jinja", "--repeat-penalty", "1.05", "--no-webui"],
    });
  });

  test("are refused where a value would not stand in a unit as it is", () => {
    const refused = (from: string, to: string) => expect(() => parseGgufSettings(SETTINGS.replace(from, to), "gguf-llm.toml")).toThrow(GgufRefused);
    refused('listen = "127.0.0.1:18051"', 'listen = "0.0.0.0:18051"');
    refused('"--no-webui"', '"--alias=%n"');
    refused('"--no-webui"', '"--chat-template ${X}"');
    refused('llama_server = "engine/build/bin/llama-server"', 'llama_server = "../engine/llama-server"');
    refused('llama_server = "engine/build/bin/llama-server"', 'llama_server = "/opt/llama-server"');
    refused("port = 8051", "port = 80");
    refused(`catalogue_command = ["${CATALOGUE}", "model"]`, "");
  });

  test("give no two registrations the same listen, name or engine port on one node", () => {
    const twice = `${SETTINGS}\n[registrations.other-7b]\nname = "other"\nnode = "echo"\nlisten = "127.0.0.1:18051"\nport = 8052\n`
      + 'context = 1\nparallel = 1\ncache_type = "f16"\ngpu_layers = 0\nflash_attn = "off"\nflags = ["--jinja"]\n';
    expect(() => parseGgufSettings(twice, "gguf-llm.toml")).toThrow("share the listen 127.0.0.1:18051");
    expect(() => parseGgufSettings(twice.replace('listen = "127.0.0.1:18051"\nport = 8052', 'listen = "127.0.0.1:18052"\nport = 8051'), "gguf-llm.toml"))
      .toThrow("share the engine port on echo port 8051");
  });
});

describe("the entry", () => {
  test("is served where its registration's settings say", () => {
    const one = instance();
    expect(one.entry).toEqual({
      name: "echo-model-q8", label: "Echo Model 7B Q8_0", file: "Echo-Model-7B-Q8_0.gguf", bytes: 7_000_000_000, sha256: SHA,
      source: "https://models.example.test/Echo-Model-7B-Q8_0.gguf", engine: ENGINE, registration: "echo-model-7b",
    });
    expect(one.serving.node).toBe("echo");
    expect(instance({ engine: null }).serving.name).toBe("echo-model");
  });

  test("is refused when another engine serves it, when it names no registration, or when the settings do not serve its registration", () => {
    expect(() => instance({ engine: "other-llm" })).toThrow("is served by other-llm");
    expect(() => instance({ registration: null })).toThrow("names no registration");
    expect(() => instance({ registration: "unknown-7b" })).toThrow("gives no [registrations.unknown-7b]");
    expect(() => instance({ file: "../escape.gguf" })).toThrow(GgufRefused);
    expect(() => instance({ sha256: "XYZ" })).toThrow(GgufRefused);
  });

  test("whose source is not https is fetched from nowhere", () => {
    expect(instance({ source: "runs/echo/model.gguf" }).entry.source).toBeNull();
  });
});

describe("the units", () => {
  test("are the templates filled with the entry's and the settings' values, and no mark is left", () => {
    const [[engineName, engine], [tunnelName, tunnel]] = renderUnits(instance(), REPOSITORY) as [[string, string], [string, string]];
    expect(engineName).toBe("echo-model-engine.service");
    expect(tunnelName).toBe("echo-model-tunnel.service");
    expect(engine).not.toContain("{{");
    expect(tunnel).not.toContain("{{");
    expect(engine).toContain("ExecStart=flock %h/.gpu.lock %h/engine/build/bin/llama-server \\\n  --model %h/echo-model/models/${MODEL_FILE} --alias ${MODEL_NAME} \\\n");
    expect(engine).toContain("--host 127.0.0.1 --port 8051 --api-key-file %h/.config/echo-model/key \\\n");
    expect(engine).toContain("--n-gpu-layers 99 --ctx-size 16384 --parallel 2 --kv-unified-per-slot 8192 \\\n");
    expect(engine).toContain("--flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 \\\n  --jinja --repeat-penalty 1.05 --no-webui\n");
    expect(engine).toContain("(the registration echo-model-7b behind agency's gateway)");
    // The process says whose it is to the node's card arbiter, as the occupant the master places it as.
    expect(engine).toContain("Environment=BMO_CARD_SERVICE=gguf-llm\n");
    expect(tunnel).toContain('"-oProxyCommand=%h/engine/.venv/bin/python %h/engine/ws-dial.py ${TUNNEL_URL}"');
    expect(tunnel).toContain("-R ${LISTEN}:127.0.0.1:8051 ${TUNNEL_LOGIN}\n");
    expect(tunnel).toContain("its loopback 18051 to this node's engine on 8051");
    // No unit names a host, an account or an address of the door.
    expect(tunnel).not.toContain(TUNNEL.url);
    expect(tunnel).not.toContain(TUNNEL.login);
  });

  test("leave the slots unheld where the settings hold none, and carry a label's percent as a unit reads it", () => {
    const loose = parseGgufSettings(SETTINGS.replace("slot_context = 8192\n", ""), "gguf-llm.toml");
    const one = instanceOf(parseEntry(JSON.stringify({ ...ENTRY, label: "Echo 100%" })), loose, "gguf-llm.toml");
    const [[, engine]] = renderUnits(one, REPOSITORY) as [[string, string]];
    expect(engine).toContain("--parallel 2 \\\n");
    expect(engine).toContain("Description=Echo 100%%, served");
  });
});

describe("the install on a stand-in node", () => {
  test("carries the key only inside its private files, fills the units and records the node once the engine answers", async () => {
    const at = stage();
    const { runner, seen } = fakeNode();

    const outcome = await installGguf(instance(), installing(runner, at, `${ENGINE}+other`));

    expect(outcome).toEqual({
      ok: true, step: null, fault: null,
      done: ["key", "home", "env", "upload", "setup", "tunnel-key", "authorized-keys", "door", "known-hosts", "units", "health", "placed"],
    });
    const commands = seen.map(commandOf);
    expect(commands[1]).toBe("mkdir -p ~/echo-model/models ~/.config/echo-model && chmod 700 ~/.config/echo-model");
    expect(commands.slice(2, 6)).toEqual([
      "upload /srv/node/.config/echo-model/env",
      "upload /srv/node/.config/echo-model/key",
      "upload /srv/node/.config/echo-model/engine.env",
      "chmod 600 ~/.config/echo-model/env ~/.config/echo-model/key ~/.config/echo-model/engine.env",
    ]);
    expect(commands.slice(6, 10)).toEqual([
      "upload /srv/node/echo-model/node-setup.sh",
      "upload /srv/node/echo-model/setup.env",
      "upload /srv/node/echo-model/echo-model-engine.service",
      "upload /srv/node/echo-model/echo-model-tunnel.service",
    ]);
    expect(seen[6]!.argv[3]).toBe(join(REPOSITORY, "runtime", "gguf-llm", "node-setup.sh"));
    expect(commands.find((command) => command.includes("systemctl --user enable")))
      .toContain("systemctl --user enable echo-model-engine.service echo-model-tunnel.service");
    expect(seen.at(-1)!.argv).toEqual([CATALOGUE, "model", "--placed", "echo-model-q8", "echo"]);

    const key = readFileSync(at.keyPath, "utf8").trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const one of seen) {
      expect(one.argv.join(" ")).not.toContain(key);
    }
    for (const line of at.said) {
      expect(line).not.toContain(key);
    }
    const carried = (suffix: string) => seen.find((one) => one.argv[4]?.endsWith(suffix))!.carried!;
    expect(carried("/.config/echo-model/env")).toEqual({
      text: `LLM_KEY=${key}\nLISTEN=127.0.0.1:18051\nTUNNEL_URL=${TUNNEL.url}\nTUNNEL_LOGIN=${TUNNEL.login}\nTUNNEL_HOST=${TUNNEL.host}\n`, mode: 0o600,
    });
    expect(carried("/.config/echo-model/key")).toEqual({ text: key, mode: 0o600 });
    expect(carried("/.config/echo-model/engine.env").text).toBe("MODEL_FILE=Echo-Model-7B-Q8_0.gguf\nMODEL_NAME=Echo-Model-7B-Q8_0\n");
    expect(carried("/echo-model/setup.env").text).toBe(
      `MODEL_FILE='Echo-Model-7B-Q8_0.gguf'\nMODEL_BYTES='7000000000'\nMODEL_SHA256='${SHA}'\n`
      + "MODEL_SOURCE='https://models.example.test/Echo-Model-7B-Q8_0.gguf'\n"
      + "LLAMA_SERVER='engine/build/bin/llama-server'\nDIAL_PYTHON='engine/.venv/bin/python'\nDIAL_SCRIPT='engine/ws-dial.py'\n",
    );
    expect(carried("/echo-model/echo-model-engine.service").text).toBe(renderUnits(instance(), REPOSITORY)[0]![1]);
    expect(readdirSync(join(at.root, "tmp"))).toEqual([]);
    expect(readFileSync(at.authorizedKeysPath, "utf8")).toBe(`${authorizedLine(keyMaterial(TUNNEL_PUB)!, "127.0.0.1:18051")}\n`);
    expect(readFileSync(at.doorListPath, "utf8")).toBe(`${at.keyPath}\n`);
  });

  test("is refused on a node reserved for other services before anything reaches it", async () => {
    const at = stage();
    const { runner, seen } = fakeNode();

    const outcome = await installGguf(instance(), installing(runner, at, "laya+other"));

    expect(outcome.ok).toBe(false);
    expect(outcome.step).toBe("reserved");
    expect(seen).toEqual([]);
    expect(existsSync(at.keyPath)).toBe(false);
  });

  test("stops at the setup's failing step and records no node", async () => {
    const at = stage();
    const { runner, seen } = fakeNode({ setup: "GGUF-LLM-SETUP-DONE failed:sha256" });

    const outcome = await installGguf(instance(), installing(runner, at));

    expect(outcome.ok).toBe(false);
    expect(outcome.step).toBe("setup");
    expect(outcome.fault).toContain("its sha256 step");
    expect(seen.some((one) => one.argv[0] === CATALOGUE)).toBe(false);
  });

  test("fails when the catalogue will not record the node", async () => {
    const at = stage();
    const { runner } = fakeNode({ placed: answer("no such entry", 1) });

    const outcome = await installGguf(instance(), installing(runner, at));

    expect(outcome.ok).toBe(false);
    expect(outcome.step).toBe("placed");
  });
});

describe("the dry run", () => {
  test("shows every file the install writes, the key standing as its file's name, and writes nothing else", () => {
    const at = stage();
    const files = plannedFiles(instance(), { checkout: REPOSITORY, tunnel: TUNNEL, keyPath: at.keyPath, hostKeyPath: at.hostKeyPath });

    expect(files.map((file) => `${file.side} ${file.path}`)).toEqual([
      "node .config/systemd/user/echo-model-engine.service",
      "node .config/systemd/user/echo-model-tunnel.service",
      "node echo-model/echo-model-engine.service",
      "node echo-model/echo-model-tunnel.service",
      "node echo-model/setup.env",
      "node echo-model/node-setup.sh",
      "node .config/echo-model/env",
      "node .config/echo-model/key",
      "node .config/echo-model/engine.env",
      "node .config/echo-model/known_hosts",
      `operations ${join(process.env.HOME!, ".ssh", "authorized_keys")}`,
      `operations ${join(at.root, "data", "env", "tunnel-door.keys")}`,
    ]);
    expect(files.find((file) => file.path.endsWith("/key"))!.text).toBe(`<the key in ${at.keyPath}>`);
    expect(files.find((file) => file.path.endsWith("/known_hosts"))!.text).toBe(`${knownHostsLine(HOST_PUB, TUNNEL.host)}\n`);
    expect(existsSync(at.keyPath)).toBe(false);

    const out = join(at.root, "out");
    writePlanned(files, out);
    expect(readFileSync(join(out, "node", ".config", "echo-model", "engine.env"), "utf8")).toBe("MODEL_FILE=Echo-Model-7B-Q8_0.gguf\nMODEL_NAME=Echo-Model-7B-Q8_0\n");
    expect(existsSync(join(out, "operations", dirname(at.doorListPath).replace(/^\//, ""), "tunnel-door.keys"))).toBe(true);
  });
});

describe("the uninstall", () => {
  test("takes the units, the settings folder, the tunnel's entry, the door's line and the key away, and leaves the models", async () => {
    const at = stage();
    mkdirSync(dirname(at.keyPath), { recursive: true });
    writeFileSync(at.keyPath, `${"ab".repeat(32)}\n`, { mode: 0o600 });
    writeFileSync(at.doorListPath, `/other/door.token\n${at.keyPath}\n`);
    mkdirSync(dirname(at.authorizedKeysPath), { recursive: true });
    writeFileSync(at.authorizedKeysPath, `ssh-ed25519 AAAAotherKey someone@else\n${authorizedLine(keyMaterial(TUNNEL_PUB)!, "127.0.0.1:18051")}\n`);
    const { runner, seen } = fakeNode();

    const outcome = await uninstallGguf(instance(), {
      runner, console: CONSOLE, keyPath: at.keyPath, doorListPath: at.doorListPath, authorizedKeysPath: at.authorizedKeysPath,
    });

    expect(outcome).toEqual({ ok: true, step: null, fault: null });
    const removal = seen.map(commandOf).find((command) => command.includes("disable --now"))!;
    expect(removal).toContain("systemctl --user disable --now echo-model-engine.service echo-model-tunnel.service");
    expect(removal).toContain("rm -rf ~/.config/echo-model");
    expect(removal).toContain("find ~/echo-model -mindepth 1 -maxdepth 1 ! -name models -exec rm -rf {} +");
    expect(readFileSync(at.authorizedKeysPath, "utf8")).toBe("ssh-ed25519 AAAAotherKey someone@else\n");
    expect(readFileSync(at.doorListPath, "utf8")).toBe("/other/door.token\n");
    expect(existsSync(at.keyPath)).toBe(false);
  });
});
