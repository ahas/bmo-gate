import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanCommand,
  collectCheckpoint,
  collectLines,
  collectedCheckpoints,
  collectedPath,
  collectionRoot,
  manifestFile,
  packCommand,
  parsePacked,
  readManifest,
  stepName,
  type CheckpointManifest,
  type CollectAsk,
} from "./laya-collect";
import { jakeDownloadArgs } from "./jake";

import { scratchDir } from "./scratch";

import type { NodeRunner, RunResult } from "./jake";

const CONSOLE = "/home/ahas/repos/ahas/jake/src/console/main.ts";
const TAR = "the bytes of a checkpoint's tar";
const SHA = createHash("sha256").update(TAR).digest("hex");

// One directory for the file, asked for at the one door that takes it away again, and a room of its
// own under it for each case.
const root = scratchDir("bmo-laya-collect-");
let made = 0;

function folder(): string {
  made += 1;
  const where = join(root, `case-${made}`);

  mkdirSync(where, { recursive: true });

  return where;
}

const answer = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

const packedText = (bytes = TAR.length, sha = SHA): string =>
  `packed=collect/r-g-step-000008.tar\nbytes=${bytes}\nsha256=${sha}\nfiles=5\n`;

interface Seen {
  argv: readonly string[];
  command: string;
}

/** A node that packs what it is asked for, and a transfer that writes the bytes it was told to. */
function fakeNode(options: { pack?: string; download?: RunResult; bytes?: string } = {}): { runner: NodeRunner; seen: Seen[] } {
  const seen: Seen[] = [];
  const runner: NodeRunner = async (argv) => {
    const command = argv[5] ?? "";

    seen.push({ argv, command });

    if (command.startsWith("echo HOME")) {
      return answer("HOME=/home/labuser\n");
    }
    if (argv[2] === "download") {
      writeFileSync(argv[4]!, options.bytes ?? TAR);

      return options.download ?? answer("downloaded");
    }
    if (command.includes("node-collect.sh pack")) {
      return answer(options.pack ?? packedText());
    }

    return answer("cleaned");
  };

  return { runner, seen };
}

/** A stand-in for opening the tar: it writes what a checkpoint's files would be. */
const fakeUnpack = async (_tarball: string, into: string) => {
  writeFileSync(join(into, "model.safetensors"), "weights");
  mkdirSync(join(into, "encoder"), { recursive: true });
  writeFileSync(join(into, "encoder", "config.json"), "{}");

  return { code: 0, stderr: "" };
};

const asking = (runner: NodeRunner, root: string, changes: Partial<CollectAsk> = {}): CollectAsk => ({
  runner,
  console: CONSOLE,
  node: "n2",
  gate: "reply-wanted",
  run: "rehearsal-713",
  step: 8,
  checkpoint: "final",
  source: "checkpoints/rehearsal-713-reply-wanted",
  dataset: "rehearsal-713",
  rehearsal: true,
  root,
  unpack: fakeUnpack,
  now: () => new Date("2026-09-23T08:30:00Z"),
  ...changes,
});

describe("where a collected checkpoint stands", () => {
  test("the gate and the step read off the name", () => {
    expect(stepName(8)).toBe("step-000008");
    expect(collectedPath("/root", "reply-wanted", "rehearsal-713", 8))
      .toBe("/root/reply-wanted/rehearsal-713/step-000008");
  });

  test("two runs of one gate do not stand on each other", () => {
    expect(collectedPath("/root", "sanitizer", "rehearsal-713", 40))
      .not.toBe(collectedPath("/root", "sanitizer", "gates-2026-09", 40));
  });

  test("the collection is under the workbench, which outlives a job", () => {
    expect(collectionRoot("worker")).toContain("/workbench/worker/laya-checkpoints");
  });
});

describe("the calls a collection is made of", () => {
  test("a final checkpoint is packed without its rolling saves", () => {
    expect(packCommand("checkpoints/r-g", "collect/r-g.tar", "final"))
      .toBe("bash ~/bmo-laya/node-collect.sh pack ~/bmo-laya/checkpoints/r-g ~/bmo-laya/collect/r-g.tar final");
    expect(packCommand("checkpoints/r-g/steps/step-000025", "collect/x.tar", "step")).toContain(" step");
  });

  test("what a collected checkpoint can be used for is written down, not guessed", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode();
      const final = await collectCheckpoint(asking(runner, root));
      const { runner: again } = fakeNode();
      const step = await collectCheckpoint(asking(again, root, {
        step: 25, checkpoint: "step", source: "checkpoints/r-g/steps/step-000025",
      }));

      expect(typeof final).not.toBe("string");
      expect(typeof step).not.toBe("string");
      // A finished checkpoint comes back whole; a rolling save comes back as the model alone, since
      // the optimizer state that would make it resumable stays on the node the resume happens on.
      expect((final as { manifest: { resumable: boolean } }).manifest.resumable).toBe(true);
      expect((step as { manifest: { resumable: boolean } }).manifest.resumable).toBe(false);
      expect(collectLines([(step as { manifest: CheckpointManifest }).manifest])[0]).toContain("모델만");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the tarball is cleaned off the node by name", () => {
    expect(cleanCommand("collect/r-g.tar")).toContain("clean ~/bmo-laya/collect/r-g.tar");
  });

  test("a download names the remote whole, since no shell reads it", () => {
    expect(jakeDownloadArgs(CONSOLE, "n2", "/home/labuser/bmo-laya/collect/x.tar", "/here/x.tar"))
      .toEqual(["bun", CONSOLE, "download", "/home/labuser/bmo-laya/collect/x.tar", "/here/x.tar", "-a", "n2"]);
  });

  test("what the packing said is read into figures", () => {
    expect(parsePacked(packedText(12345))).toEqual({ packed: "collect/r-g-step-000008.tar", bytes: 12345, sha256: SHA, files: 5 });
  });

  test("a packing that found nothing says so in its own words", () => {
    expect(parsePacked("fault=no-checkpoint\n")).toBe("노드에 그 체크포인트가 없어요.");
    expect(typeof parsePacked("fault=tar\n")).toBe("string");
    expect(typeof parsePacked("nothing we know\n")).toBe("string");
    expect(typeof parsePacked("packed=x\nbytes=0\nsha256=zz\n")).toBe("string");
  });
});

describe("carrying one back", () => {
  test("nothing is asked of a node that is not a training node", async () => {
    const root = folder();

    try {
      const { runner, seen } = fakeNode();
      const collected = await collectCheckpoint(asking(runner, root, { node: "n6" }));

      expect(collected).toContain("n6 은(는) 학습 노드가 아니에요");
      expect(seen).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("it is packed, brought over, checked and unpacked with its manifest", async () => {
    const root = folder();

    try {
      const { runner, seen } = fakeNode();
      const collected = await collectCheckpoint(asking(runner, root));

      expect(typeof collected).not.toBe("string");
      if (typeof collected === "string") {
        return;
      }

      expect(collected.folder).toBe(collectedPath(root, "reply-wanted", "rehearsal-713", 8));
      expect(existsSync(join(collected.folder, "model.safetensors"))).toBe(true);
      expect(existsSync(join(collected.folder, "encoder", "config.json"))).toBe(true);

      const manifest = readManifest(collected.folder)!;

      expect(manifest.gate).toBe("reply-wanted");
      expect(manifest.node).toBe("n2");
      expect(manifest.step).toBe(8);
      expect(manifest.checkpoint).toBe("final");
      expect(manifest.rehearsal).toBe(true);
      expect(manifest.bytes).toBe(TAR.length);
      expect(manifest.sha256).toBe(SHA);
      expect(manifest.source).toBe("checkpoints/rehearsal-713-reply-wanted");
      expect(manifest.collected).toBe("2026-09-23T08:30:00.000Z");

      // The tarball is not left standing on the node, and nothing is left in the incoming folder.
      expect(seen.some((one) => one.command.includes("node-collect.sh clean"))).toBe(true);
      expect(existsSync(join(root, ".incoming", "rehearsal-713-reply-wanted-step-000008.tar"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("one already collected under the same gate and step is not written over", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode();

      expect(typeof await collectCheckpoint(asking(runner, root))).not.toBe("string");

      const { runner: again, seen } = fakeNode();
      const second = await collectCheckpoint(asking(again, root, { node: "n5" }));

      expect(typeof second).toBe("string");
      expect(second as string).toContain("덮어쓰지 않아요");
      expect(seen.length).toBe(0);
      expect(readManifest(collectedPath(root, "reply-wanted", "rehearsal-713", 8))!.node).toBe("n2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("it is written over only where the caller says outright", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode();

      await collectCheckpoint(asking(runner, root));

      const { runner: again } = fakeNode();
      const second = await collectCheckpoint(asking(again, root, { node: "n5", overwrite: true }));

      expect(typeof second).not.toBe("string");
      expect(readManifest(collectedPath(root, "reply-wanted", "rehearsal-713", 8))!.node).toBe("n5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a step of the same gate stands beside the final one rather than on it", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode();

      await collectCheckpoint(asking(runner, root));

      const { runner: again } = fakeNode();

      expect(typeof await collectCheckpoint(asking(again, root, {
        step: 25, checkpoint: "step", source: "checkpoints/rehearsal-713-reply-wanted/steps/step-000025",
      }))).not.toBe("string");

      expect(collectedCheckpoints(root).map((one) => one.step).sort((a, b) => a - b)).toEqual([8, 25]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bytes that came over wrong are thrown away rather than kept", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode({ bytes: "something else entirely" });
      const collected = await collectCheckpoint(asking(runner, root));

      expect(typeof collected).toBe("string");
      expect(collected as string).toContain("달라요");
      expect(existsSync(collectedPath(root, "reply-wanted", "rehearsal-713", 8))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a transfer that failed leaves nothing that reads as collected", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode({ download: answer("the tunnel closed", 4) });
      const collected = await collectCheckpoint(asking(runner, root));

      expect(typeof collected).toBe("string");
      expect(existsSync(collectedPath(root, "reply-wanted", "rehearsal-713", 8))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unpacking that broke leaves no half-collected folder", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode();
      const collected = await collectCheckpoint(asking(runner, root, {
        unpack: async () => ({ code: 2, stderr: "tar: unexpected end of file" }),
      }));

      expect(typeof collected).toBe("string");
      expect(collected as string).toContain("풀지 못했어요");
      expect(existsSync(collectedPath(root, "reply-wanted", "rehearsal-713", 8))).toBe(false);
      expect(existsSync(`${collectedPath(root, "reply-wanted", "rehearsal-713", 8)}.partial`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a node that does not answer is said to be out of reach", async () => {
    const root = folder();

    try {
      const collected = await collectCheckpoint(asking(async () => answer("", 255), root));

      expect(collected as string).toContain("노드가 답하지 않아요");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a checkpoint the node does not have is named, not invented", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode({ pack: "fault=no-checkpoint\n" });

      expect(await collectCheckpoint(asking(runner, root))).toBe("노드에 그 체크포인트가 없어요.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("what stands in the collection", () => {
  test("every manifest is found, and a half-written one is passed over", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode();

      await collectCheckpoint(asking(runner, root));
      mkdirSync(join(root, "sanitizer", "rehearsal-713", "step-000040.partial"), { recursive: true });
      writeFileSync(join(root, "sanitizer", "rehearsal-713", "step-000040.partial", manifestFile),
        JSON.stringify({ kind: "laya-checkpoint", gate: "sanitizer" }));

      const standing = collectedCheckpoints(root);

      expect(standing.map((one) => one.gate)).toEqual(["reply-wanted"]);
      expect(collectLines(standing)[0]).toContain("reply-wanted/rehearsal-713/step-000008");
      expect(collectLines(standing)[0]).toContain("리허설");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a folder that is not ours is not read as a manifest", () => {
    const root = folder();

    try {
      mkdirSync(join(root, "gate", "run", "step-000001"), { recursive: true });
      writeFileSync(join(root, "gate", "run", "step-000001", manifestFile), JSON.stringify({ kind: "something-else" }));

      expect(collectedCheckpoints(root)).toEqual([]);
      expect(collectLines([])).toEqual(["가져온 체크포인트가 아직 없어요."]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nothing collected yet reads as nothing rather than breaking", () => {
    expect(collectedCheckpoints(join(root, "nothing-collected-here"))).toEqual([]);
  });

  test("a manifest read back is the one that was written", async () => {
    const root = folder();

    try {
      const { runner } = fakeNode();
      const collected = await collectCheckpoint(asking(runner, root));

      if (typeof collected === "string") {
        throw new Error(collected);
      }

      expect(JSON.parse(readFileSync(join(collected.folder, manifestFile), "utf8"))).toEqual(collected.manifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
