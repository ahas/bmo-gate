import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MANIFEST_KIND } from "../../training/tooling/src/laya-collect";
import { namedSettings, releaseGate, releasedSettings, serveCheckpoint, type ReleaseAsk, type ServeAsk } from "../../training/tooling/src/laya-serve";
import { servingCheckpoint } from "../../training/tooling/src/laya-service";
import { scratchDir } from "./scratch";

import type { NodeRunner, RunResult } from "../../training/tooling/src/node-calls";

const CONSOLE = "/opt/console/main.ts";
const CHECKPOINT = "output-format/real-1-hand/step-000044";
const TAR = "the checkpoint, packed";

const answer = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

interface Node {
  runner: NodeRunner;
  commands: string[];
  /** What each upload carried, by where it went. */
  carried: Map<string, string>;
}

function fakeNode(options: { standing?: boolean; settings?: string; hashOnNode?: string } = {}): Node {
  const commands: string[] = [];
  const carried = new Map<string, string>();
  const runner: NodeRunner = async (argv) => {
    if (argv[2] === "upload") {
      carried.set(argv[4]!, readFileSync(argv[3]!, "utf8"));
      commands.push(`upload ${argv[4]}`);

      return answer("");
    }
    const command = argv[5] ?? "";
    commands.push(command);
    if (command.startsWith("echo HOME")) {
      return answer("HOME=/srv/trainer\n");
    }
    if (command.startsWith("test -f")) {
      return answer(options.standing === true ? "standing\n" : "absent\n");
    }
    if (command.includes("sha256sum")) {
      const sent = createHash("sha256").update(TAR).digest("hex");
      return (options.hashOnNode ?? sent) === sent && command.includes(sent) ? answer("placed\n") : answer("fault=hash\n", 1);
    }
    if (command.startsWith("cat ")) {
      return answer(options.settings ?? "");
    }

    return answer("");
  };

  return { runner, commands, carried };
}

function collection(): string {
  const root = scratchDir("bmo-laya-serve-");
  const folder = join(root, CHECKPOINT);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ kind: MANIFEST_KIND }));
  mkdirSync(join(root, "tmp"));

  return root;
}

function asking(node: Node, root: string, changes: Partial<ServeAsk> = {}): ServeAsk {
  return {
    runner: node.runner,
    console: CONSOLE,
    node: "echo",
    checkpoint: CHECKPOINT,
    root,
    tmpRoot: join(root, "tmp"),
    pack: async (_folder, tarball) => {
      writeFileSync(tarball, TAR);
      return { code: 0, stderr: "" };
    },
    health: async () => ({ gates: { "output-format": { model: `checkpoints/${CHECKPOINT}` } } }),
    wait: async () => {},
    healthPolls: 2,
    ...changes,
  };
}

describe("the settings file a gate is named in", () => {
  test("the gate's pair is replaced and every other pair and line is left as it stood", () => {
    const text = 'LAYA_CARD_MODELS=8\nLAYA_CHECKPOINTS="output-decide=checkpoints/a/r/step-000001 output-format=checkpoints/b/r/step-000002"\n';
    expect(namedSettings(text, "output-format", CHECKPOINT))
      .toBe(`LAYA_CARD_MODELS=8\nLAYA_CHECKPOINTS="output-decide=checkpoints/a/r/step-000001 output-format=checkpoints/${CHECKPOINT}"\n`);
  });

  test("a gate not named yet is added, and a file naming none gains the setting", () => {
    expect(namedSettings('LAYA_CHECKPOINTS=""\n', "output-format", CHECKPOINT)).toBe(`LAYA_CHECKPOINTS="output-format=checkpoints/${CHECKPOINT}"\n`);
    expect(namedSettings("", "output-format", CHECKPOINT)).toBe(`LAYA_CHECKPOINTS="output-format=checkpoints/${CHECKPOINT}"\n`);
  });

  test("the checkpoint serving a gate is read off the engine's health", () => {
    expect(servingCheckpoint({ gates: { a: { model: "checkpoints/x" } } }, "a")).toBe("checkpoints/x");
    expect(servingCheckpoint({ gates: {} }, "a")).toBeNull();
    expect(servingCheckpoint(null, "a")).toBeNull();
  });
});

describe("putting a checkpoint in service", () => {
  test("it crosses in parts under the hub's limit, is joined and checked on the node and only then given its name", async () => {
    const root = collection();
    const node = fakeNode();

    expect(await serveCheckpoint(asking(node, root, { partBytes: 8 }))).toEqual({ carried: true, gate: null });

    const tarball = "incoming/output-format-real-1-hand-step-000044.tar";
    const parts = [...node.carried.keys()];
    expect(parts).toEqual(["000", "001", "002"].map((n) => `/srv/trainer/bmo-laya/${tarball}.part-${n}`));
    expect(parts.map((part) => node.carried.get(part)).join("")).toBe(TAR);
    const placing = node.commands.find((command) => command.includes("sha256sum"))!;
    expect(placing).toContain(createHash("sha256").update(TAR).digest("hex"));
    expect(placing.indexOf(`cat ${tarball}.part-* > ${tarball}`)).toBeLessThan(placing.indexOf("sha256sum"));
    expect(placing.indexOf(`tar -xf ${tarball} -C checkpoints/${CHECKPOINT}.partial`))
      .toBeLessThan(placing.indexOf(`mv checkpoints/${CHECKPOINT}.partial checkpoints/${CHECKPOINT}`));
    expect(node.commands.some((command) => command.includes("restart"))).toBe(false);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });

  test("a tarball that arrived different is not placed", async () => {
    const root = collection();

    expect(await serveCheckpoint(asking(fakeNode({ hashOnNode: "0".repeat(64) }), root))).toContain("differs");
  });

  test("one already standing on the node is not carried again", async () => {
    const node = fakeNode({ standing: true });

    expect(await serveCheckpoint(asking(node, collection()))).toEqual({ carried: false, gate: null });
    expect(node.carried.size).toBe(0);
  });

  test("naming it for a gate writes that pair alone, restarts the engine and waits until health says so", async () => {
    const node = fakeNode({ standing: true, settings: 'LAYA_CHECKPOINTS="output-decide=checkpoints/a/r/step-000001"\n' });

    expect(await serveCheckpoint(asking(node, collection(), { gate: "output-format" }))).toEqual({ carried: false, gate: "output-format" });
    expect(node.carried.get("/srv/trainer/.config/bmo-laya/env"))
      .toBe(`LAYA_CHECKPOINTS="output-decide=checkpoints/a/r/step-000001 output-format=checkpoints/${CHECKPOINT}"\n`);
    expect(node.commands.at(-1)).toContain("systemctl --user restart bmo-llm-laya.service");
  });

  test("an engine that never answers with the new checkpoint is said so", async () => {
    const node = fakeNode({ standing: true });

    expect(await serveCheckpoint(asking(node, collection(), { gate: "output-format", health: async () => null }))).toContain("journalctl");
  });

  test("a name that is not a collected checkpoint reaches no node", async () => {
    const node = fakeNode();
    const root = collection();

    expect(await serveCheckpoint(asking(node, root, { checkpoint: "output-format/real-1-hand" }))).toContain("is not of the shape");
    expect(await serveCheckpoint(asking(node, root, { checkpoint: "output-format/other/step-000001" }))).toContain("laya-collect");
    expect(await serveCheckpoint(asking(node, root, { gate: "Room Rules" }))).toContain("is not a gate's name");
    expect(node.commands).toEqual([]);
    expect(existsSync(join(root, "output-format", "other"))).toBe(false);
  });
});

describe("releasing a gate the gate service no longer asks", () => {
  const settings = `LAYA_CARD_MODELS=8\nLAYA_CHECKPOINTS="content-judge=checkpoints/c/r/step-000060 output-format=checkpoints/${CHECKPOINT}"\n`;

  function releasing(node: Node, changes: Partial<ReleaseAsk> = {}): ReleaseAsk {
    return {
      runner: node.runner,
      console: CONSOLE,
      node: "echo",
      gate: "content-judge",
      tmpRoot: scratchDir("bmo-laya-release-"),
      health: async () => ({ gates: { "output-format": { model: `checkpoints/${CHECKPOINT}` } } }),
      wait: async () => {},
      healthPolls: 2,
      ...changes,
    };
  }

  test("takes the gate's pair out, leaves every other pair and line, and touches no checkpoint", async () => {
    const node = fakeNode({ settings });

    expect(await releaseGate(releasing(node))).toEqual({ released: true });
    expect(node.carried.get("/srv/trainer/.config/bmo-laya/env")).toBe(`LAYA_CARD_MODELS=8\nLAYA_CHECKPOINTS="output-format=checkpoints/${CHECKPOINT}"\n`);
    expect(node.commands.at(-1)).toContain("systemctl --user restart bmo-llm-laya.service");
    expect(node.commands.some((command) => command.includes("rm "))).toBe(false);
  });

  test("a node without the pair is left as it is and not restarted", async () => {
    const node = fakeNode({ settings: `LAYA_CHECKPOINTS="output-format=checkpoints/${CHECKPOINT}"\n` });

    expect(await releaseGate(releasing(node))).toEqual({ released: false });
    expect(releasedSettings("", "content-judge")).toBeNull();
    expect(node.carried.size).toBe(0);
    expect(node.commands.some((command) => command.includes("restart"))).toBe(false);
  });

  test("an engine that still names the gate is said so", async () => {
    const node = fakeNode({ settings });
    const health = async () => ({ gates: { "content-judge": { model: "checkpoints/c/r/step-000060" } } });

    expect(await releaseGate(releasing(node, { health }))).toContain("journalctl");
  });
});
