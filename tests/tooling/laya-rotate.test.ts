import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { manifestFile, MANIFEST_KIND, type CheckpointKind, type CheckpointManifest } from "../../training/tooling/src/laya-collect";
import {
  passTraining,
  readRotation,
  readServed,
  ROTATION_DEFAULTS,
  ROTATION_FILE,
  rotateCollection,
  SERVED_FILE,
  servedNow,
  type ServedPair,
} from "../../training/tooling/src/laya-rotate";
import { ledgerFile } from "../../training/tooling/src/train/ledger";

import { scratchDir } from "./scratch";
import { useToolingSettings } from "./settings";

useToolingSettings();

const root = scratchDir("bmo-laya-rotate-");
let made = 0;

function folder(): string {
  made += 1;
  const where = join(root, `case-${made}`);

  mkdirSync(where, { recursive: true });

  return where;
}

interface Laid {
  rehearsal?: boolean;
  kind?: CheckpointKind;
}

// One collected checkpoint laid out as the collection holds it, its manifest saying when it was collected.
function lay(at: string, checkpoint: string, collected: string, laid: Laid = {}): void {
  const [gate, run, step] = checkpoint.split("/") as [string, string, string];
  const where = join(at, checkpoint);
  const manifest: CheckpointManifest = {
    kind: MANIFEST_KIND, checkpoint: laid.kind ?? "final", gate, run, node: "alpha", step: Number(step.slice(5)), dataset: run,
    rehearsal: laid.rehearsal ?? false, bytes: 1_000_000, files: 3, sha256: "0".repeat(64), source: `checkpoints/${run}-${gate}`,
    collected, resumable: true,
  };

  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, "model.safetensors"), "weights");
  writeFileSync(join(where, manifestFile), JSON.stringify(manifest));
}

const serving = (...pairs: ServedPair[]) => async () => pairs;
const never = () => false;

describe("rotating the collection", () => {
  test("keeps what is served, the gate's previous deployment and the newest candidate, and removes the rest", async () => {
    const at = folder();
    lay(at, "session-summary/ref-1-p0001/step-000100", "2026-09-01T00:00:00Z");
    lay(at, "session-summary/ref854-p0001/step-000644", "2026-09-02T00:00:00Z");
    lay(at, "session-summary/ref895-plain-p0001/step-000640", "2026-09-03T00:00:00Z");
    lay(at, "session-summary/ref-1-p0041/step-000624", "2026-09-04T00:00:00Z");
    lay(at, "session-summary/ref-1-p0042/step-000604", "2026-09-05T00:00:00Z");
    writeFileSync(join(at, SERVED_FILE), [
      { gate: "session-summary", checkpoint: "session-summary/ref-1-p0001/step-000100", at: "2026-09-01T01:00:00Z" },
      { gate: "session-summary", checkpoint: "session-summary/ref854-p0001/step-000644", at: "2026-09-02T01:00:00Z" },
    ].map((line) => `${JSON.stringify(line)}\n`).join(""));

    const rotation = await rotateCollection({
      root: at, training: never, now: () => new Date("2026-10-06T00:00:00Z"),
      served: serving({ gate: "session-summary", checkpoint: "session-summary/ref895-plain-p0001/step-000640" }),
    });

    if (typeof rotation === "string") throw new Error(rotation);
    expect(rotation.plan.keep.map((one) => [one.checkpoint, one.why])).toEqual([
      ["session-summary/ref-1-p0042/step-000604", "candidate"],
      ["session-summary/ref854-p0001/step-000644", "deployed"],
      ["session-summary/ref895-plain-p0001/step-000640", "served"],
    ]);
    expect(existsSync(join(at, "session-summary/ref-1-p0001"))).toBe(false);
    expect(existsSync(join(at, "session-summary/ref-1-p0041"))).toBe(false);
    expect(existsSync(join(at, "session-summary/ref854-p0001/step-000644/model.safetensors"))).toBe(true);
    expect(rotation.freed).toBe(2_000_000);
    // What is served now became the gate's latest line.
    expect(readServed(at).at(-1)).toEqual({ gate: "session-summary", checkpoint: "session-summary/ref895-plain-p0001/step-000640", at: "2026-10-06T00:00:00.000Z" });
  });

  test("never removes a served checkpoint, however old, rehearsed or rolling, and with the fewest settings", async () => {
    const at = folder();
    lay(at, "content-judge/drivecheck/step-000001", "2026-09-01T00:00:00Z", { rehearsal: true, kind: "step" });
    lay(at, "content-judge/real-1-p0004/step-000228", "2026-09-02T00:00:00Z");
    writeFileSync(join(at, ROTATION_FILE), JSON.stringify({ deployed: 1, candidates: 0 }));

    const rotation = await rotateCollection({
      root: at, training: never, served: serving({ gate: "content-judge", checkpoint: "content-judge/drivecheck/step-000001" }),
    });

    if (typeof rotation === "string") throw new Error(rotation);
    expect(rotation.plan.keep.map((one) => one.checkpoint)).toEqual(["content-judge/drivecheck/step-000001"]);
    expect(existsSync(join(at, "content-judge/drivecheck/step-000001"))).toBe(true);
    expect(existsSync(join(at, "content-judge/real-1-p0004"))).toBe(false);
  });

  test("leaves every checkpoint of a pass still training, rolling saves included", async () => {
    const at = folder();
    lay(at, "knowledge-classifier/ref-1-p0042/step-000025", "2026-09-01T00:00:00Z", { kind: "step" });
    lay(at, "knowledge-classifier/ref-1-p0042/step-000050", "2026-09-02T00:00:00Z", { kind: "step" });
    lay(at, "knowledge-classifier/ref-1-p0041/step-000092", "2026-09-03T00:00:00Z");
    lay(at, "knowledge-classifier/ref-1-p0040/step-000092", "2026-09-04T00:00:00Z");

    const rotation = await rotateCollection({
      root: at, training: (run) => run === "ref-1-p0042", served: serving(),
      now: () => new Date("2026-10-06T00:00:00Z"),
    });

    if (typeof rotation === "string") throw new Error(rotation);
    expect(rotation.plan.keep.map((one) => [one.checkpoint, one.why])).toEqual([
      ["knowledge-classifier/ref-1-p0040/step-000092", "candidate"],
      ["knowledge-classifier/ref-1-p0042/step-000025", "training"],
      ["knowledge-classifier/ref-1-p0042/step-000050", "training"],
    ]);
  });

  test("a rehearsal or a rolling save is never a candidate, nor anything collected before what is served", async () => {
    const at = folder();
    lay(at, "reply-wanted/real-1-p0002/step-000072", "2026-09-01T00:00:00Z");
    lay(at, "reply-wanted/real-1-hand/step-000072", "2026-09-02T00:00:00Z");
    lay(at, "reply-wanted/replycheck/step-000002", "2026-09-03T00:00:00Z", { rehearsal: true });
    lay(at, "reply-wanted/real-1-p0003/step-000010", "2026-09-04T00:00:00Z", { kind: "step" });

    const rotation = await rotateCollection({
      root: at, training: never, served: serving({ gate: "reply-wanted", checkpoint: "reply-wanted/real-1-hand/step-000072" }),
    });

    if (typeof rotation === "string") throw new Error(rotation);
    expect(rotation.plan.keep.map((one) => one.checkpoint)).toEqual(["reply-wanted/real-1-hand/step-000072"]);
  });

  test("a service that cannot say what it serves stops the rotation before anything goes", async () => {
    const at = folder();
    lay(at, "translator/real-1-p0002/step-000068", "2026-09-01T00:00:00Z");
    lay(at, "translator/real-1-p0004/step-000092", "2026-09-02T00:00:00Z");

    const rotation = await rotateCollection({
      root: at, training: never,
      served: () => servedNow([{ node: "node-a", listen: "127.0.0.1:18013", cardModels: null, hostCopy: null }], async () => null),
    });

    expect(rotation).toContain("node-a");
    expect(existsSync(join(at, "translator/real-1-p0002/step-000068"))).toBe(true);
    expect(existsSync(join(at, SERVED_FILE))).toBe(false);
  });

  test("a dry run removes nothing and records nothing", async () => {
    const at = folder();
    lay(at, "output-decide/ref-1-p0011/step-000060", "2026-09-01T00:00:00Z");
    lay(at, "output-decide/ref-1-p0012/step-000064", "2026-09-02T00:00:00Z");

    const rotation = await rotateCollection({
      root: at, training: never, dryRun: true,
      served: serving({ gate: "output-decide", checkpoint: "output-decide/ref-1-p0012/step-000064" }),
    });

    if (typeof rotation === "string") throw new Error(rotation);
    expect(rotation.plan.drop.map((one) => one.checkpoint)).toEqual(["output-decide/ref-1-p0011/step-000060"]);
    expect(existsSync(join(at, "output-decide/ref-1-p0011/step-000060"))).toBe(true);
    expect(existsSync(join(at, SERVED_FILE))).toBe(false);
  });

  test("what the nodes serve is read off their health without the engine's folder prefix", async () => {
    const health = async (url: string) => ({ gates: { "output-format": { model: `checkpoints/output-format/${url.endsWith("13") ? "real-2-fold" : "real-1-hand"}/step-000048` } } });

    expect(await servedNow([
      { node: "a", listen: "127.0.0.1:18013", cardModels: null, hostCopy: null },
      { node: "b", listen: "127.0.0.1:18014", cardModels: null, hostCopy: null },
    ], health)).toEqual([
      { gate: "output-format", checkpoint: "output-format/real-2-fold/step-000048" },
      { gate: "output-format", checkpoint: "output-format/real-1-hand/step-000048" },
    ]);
  });
});

describe("the rotation's settings", () => {
  test("default where the file is absent, and refused where malformed", () => {
    const at = folder();

    expect(readRotation(at)).toEqual(ROTATION_DEFAULTS);
    writeFileSync(join(at, ROTATION_FILE), JSON.stringify({ deployed: 3 }));
    expect(readRotation(at)).toEqual({ deployed: 3, candidates: 1 });
    writeFileSync(join(at, ROTATION_FILE), JSON.stringify({ deployed: 0 }));
    expect(readRotation(at)).toContain(ROTATION_FILE);
    writeFileSync(join(at, ROTATION_FILE), "{");
    expect(readRotation(at)).toContain("JSON");
  });

  test("a malformed file stops the rotation with the collection untouched", async () => {
    const at = folder();
    lay(at, "output-format/peek-1/step-000152", "2026-09-01T00:00:00Z");
    writeFileSync(join(at, ROTATION_FILE), JSON.stringify({ candidates: -1 }));

    expect(await rotateCollection({ root: at, training: never, served: serving() })).toContain(ROTATION_FILE);
    expect(readFileSync(join(at, "output-format/peek-1/step-000152/model.safetensors"), "utf8")).toBe("weights");
  });
});

describe("a pass still training", () => {
  test("is one with no ledger whose source's curve a living process claims", () => {
    const at = folder();
    const where = { runs: join(at, "runs"), curves: join(at, "curves"), alive: (pid: number) => pid === 42 };
    mkdirSync(join(where.curves, "ref-1"), { recursive: true });
    writeFileSync(join(where.curves, "ref-1", ".writer.1.42"), "");
    mkdirSync(join(where.curves, "real-1"), { recursive: true });
    writeFileSync(join(where.curves, "real-1", ".writer.1.7"), "");
    mkdirSync(join(where.runs, "ref-1-p0041"), { recursive: true });
    writeFileSync(join(where.runs, "ref-1-p0041", ledgerFile), "{}");

    expect(passTraining("ref-1-p0042", where)).toBe(true);
    expect(passTraining("ref-1-p0041", where)).toBe(false);
    expect(passTraining("real-1-p0013", where)).toBe(false);
    expect(passTraining("real-1-hand", where)).toBe(false);
  });
});
