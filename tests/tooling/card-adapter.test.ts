import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { answerLine, readAsk, runAdapter } from "../../training/tooling/src/card-adapter";
import { layaAdapter } from "../../training/tooling/src/laya-adapter";
import { NODE_FILE_PATHS } from "../../training/tooling/src/laya-nodes";
import { layaTrainAdapter } from "../../training/tooling/src/laya-train-adapter";
import { scratchDir } from "./scratch";

import type { AdapterAnswer } from "../../training/tooling/src/card-adapter";
import type { NodeCalls, RunResult } from "../../training/tooling/src/node-calls";

const answer = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

// The one shape every verb of every adapter answers the card master with (the arbiter's docs/placement.md,
// 「An adapter's verbs」).
function shaped(said: AdapterAnswer): void {
  const read = JSON.parse(answerLine(said)) as Record<string, unknown>;
  expect(Object.keys(read).filter((key) => key !== "nodes").sort()).toEqual(["detail", "node", "ok", "state"]);
  expect(typeof read.ok).toBe("boolean");
  expect(read.state === null || ["running", "stopped", "absent", "failing"].includes(read.state as string)).toBe(true);
}

function placements(files: Record<string, unknown>): string {
  const root = scratchDir("bmo-card-adapter-");
  mkdirSync(join(root, "placements"));
  for (const [file, value] of Object.entries(files)) {
    writeFileSync(join(root, "placements", file), JSON.stringify(value));
  }
  return root;
}

function node(commands: string[]): NodeCalls {
  return {
    exec: async (command) => {
      commands.push(command);
      return answer("HOME=/srv/trainer\n");
    },
    upload: async () => answer(""),
    download: async () => answer(""),
  };
}

describe("the adapter's words", () => {
  test("a verb, its node and the placed nodes are read, and anything else refused", () => {
    expect(readAsk(["install", "--node", "bravo", "--placed", "alpha,bravo"])).toEqual({ verb: "install", node: "bravo", placed: ["alpha", "bravo"] });
    expect(readAsk(["placed", "--placed", ""])).toEqual({ verb: "placed", node: null, placed: [] });
    expect(readAsk(["move", "--node", "bravo"])).toContain("install, uninstall");
    expect(readAsk(["install", "--placed", "alpha"])).toBe("install needs --node");
  });
});

describe("the Laya service's adapter", () => {
  const PLACEMENT = { nodes: [{ node: "ops-box", listen: "127.0.0.1:18011", cardModels: 4 }, { node: "foxtrot", listen: "127.0.0.1:18012" }] };

  test("names its placement's nodes, and answers each node's health in the one shape", async () => {
    const root = placements({ "laya-service.json": PLACEMENT });
    const hands = { runner: async () => answer(""), console: "/console", root, health: async (listen: string) => (listen.endsWith("18011") ? { gates: {} } : null) };

    const placed = await layaAdapter({ verb: "placed", node: null, placed: [] }, hands);
    shaped(placed);
    expect(placed.nodes).toEqual(["ops-box", "foxtrot"]);
    const running = await layaAdapter({ verb: "health", node: "ops-box", placed: [] }, hands);
    shaped(running);
    expect(running.state).toBe("running");
    expect((await layaAdapter({ verb: "health", node: "foxtrot", placed: [] }, hands)).state).toBe("failing");
    expect((await layaAdapter({ verb: "health", node: "charlie", placed: [] }, hands)).state).toBe("absent");
  });

  test("uninstall writes the placement as the master placed it, entries kept, and stops the node's units", async () => {
    const root = placements({ "laya-service.json": PLACEMENT });
    const commands: string[] = [];

    const said = await layaAdapter({ verb: "uninstall", node: "ops-box", placed: ["foxtrot"] }, {
      runner: async () => answer(""), console: "/console", root, reach: async () => ({ calls: node(commands), role: null }),
    });

    shaped(said);
    expect([said.ok, said.state]).toEqual([true, "stopped"]);
    expect(JSON.parse(readFileSync(join(root, "placements", "laya-service.json"), "utf8"))).toEqual({ nodes: [{ node: "foxtrot", listen: "127.0.0.1:18012" }] });
    expect(commands.some((command) => command.includes("disable --now bmo-llm-laya.service bmo-llm-front.service bmo-llm-tunnel.service"))).toBe(true);
  });

  test("install puts a new node last at the lowest free listen and installs the service there", async () => {
    const root = placements({ "laya-service.json": { nodes: [PLACEMENT.nodes[0]] } });
    const installed: string[] = [];

    const said = await layaAdapter({ verb: "install", node: "delta", placed: ["ops-box", "delta"] }, {
      runner: async () => answer(""), console: "/console", root, reach: async () => ({ calls: node([]), role: null }),
      health: async () => null,
      install: async (at) => {
        installed.push(`${at.node} ${at.listen}`);
        return { ok: true, step: null, fault: null, done: [] };
      },
    });

    shaped(said);
    expect(said.ok).toBe(true);
    expect(installed).toEqual(["delta 127.0.0.1:18012"]);
    expect(JSON.parse(readFileSync(join(root, "placements", "laya-service.json"), "utf8")).nodes.map((one: { node: string }) => one.node)).toEqual(["ops-box", "delta"]);
  });
});

describe("Laya training's adapter", () => {
  test("adds and takes off nodes of the training placement, answering in the one shape", async () => {
    const root = placements({ "laya-training.json": { nodes: ["delta"] } });
    // A repository of its own holding every file a training node is given, the project file pinning laya.
    const repository = scratchDir("bmo-card-adapter-repository-");
    for (const path of NODE_FILE_PATHS) {
      mkdirSync(join(repository, path, ".."), { recursive: true });
      writeFileSync(join(repository, path), path.endsWith("pyproject.toml") ? '[project]\ndependencies = ["laya==0.3.5"]\n' : `${path}\n`);
    }
    const hands = {
      runner: async () => answer(""), console: "/console", root, repository, reach: async () => node([]),
      stand: async (name: string) => ({ node: name, probe: null, uploaded: [], setup: "already right" as const, ready: true, missing: [], fault: null, seconds: 0 }),
    };

    const placed = await layaTrainAdapter({ verb: "placed", node: null, placed: [] }, hands);
    shaped(placed);
    expect(placed.nodes).toEqual(["delta"]);
    const added = await layaTrainAdapter({ verb: "install", node: "ops-box", placed: ["delta", "ops-box"] }, hands);
    shaped(added);
    expect(added.state).toBe("running");
    expect(JSON.parse(readFileSync(join(root, "placements", "laya-training.json"), "utf8"))).toEqual({ nodes: ["delta", "ops-box"] });
    const taken = await layaTrainAdapter({ verb: "uninstall", node: "delta", placed: ["ops-box"] }, hands);
    shaped(taken);
    expect(JSON.parse(readFileSync(join(root, "placements", "laya-training.json"), "utf8"))).toEqual({ nodes: ["ops-box"] });
  });
});

describe("an adapter run whole", () => {
  test("ends with its answer as the last line, and a work that throws answers that it failed", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });

    try {
      expect(await runAdapter(["health", "--node", "bravo"], async (ask) => ({ ok: true, node: ask.node, state: "running", detail: "" }))).toBe(0);
      expect(await runAdapter(["health", "--node", "bravo"], async () => {
        throw new Error("the stand-in broke");
      })).toBe(1);
      expect(await runAdapter(["move"], async () => {
        throw new Error("never asked");
      })).toBe(1);
    } finally {
      log.mockRestore();
    }

    const read = lines.map((line) => JSON.parse(line) as AdapterAnswer);
    for (const one of read) {
      shaped(one);
    }
    expect(read[0]).toEqual({ ok: true, node: "bravo", state: "running", detail: "" });
    expect(read[1]).toEqual({ ok: false, node: "bravo", state: null, detail: "the stand-in broke" });
    expect(read[2]!.detail).toContain("install, uninstall");
  });
});
