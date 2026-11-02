import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { nodeCalls, runFault, spawnRunner } from "../../training/tooling/src/node-calls";
import { scratchDir } from "./scratch";

import type { NodeRunner, RunResult } from "../../training/tooling/src/node-calls";

const root = scratchDir("bmo-node-calls-");
const CONSOLE = "/opt/console/main.ts";

describe("a call on a node", () => {
  test("is waited for until it exits, whatever it took, and answers what it wrote", async () => {
    const result = await spawnRunner(["sh", "-c", "printf half; sleep 0.3; echo fine"]);

    expect(result).toEqual({ code: 0, stdout: "halffine\n", stderr: "" });
  });

  test("that failed answers its own exit and what it wrote", async () => {
    const result = await spawnRunner(["sh", "-c", "echo refused >&2; exit 3"]);

    expect(result).toEqual({ code: 3, stdout: "", stderr: "refused\n" });
  });
});

describe("why a call failed", () => {
  test("the exit code and stderr, falling back to stdout", () => {
    expect(runFault({ code: 2, stdout: "", stderr: "no such file\n" })).toBe("exit code 2 — no such file");
    expect(runFault({ code: 1, stdout: "refused\n", stderr: "" })).toBe("exit code 1 — refused");
  });

  test("a call that wrote nothing is never a blank", () => {
    expect(runFault({ code: 143, stdout: "", stderr: "" })).toBe("exit code 143, no output");
  });
});

describe("the calls on one node", () => {
  const recording = (answers: RunResult[]) => {
    const seen: Array<{ argv: readonly string[] }> = [];
    const runner: NodeRunner = async (argv) => {
      seen.push({ argv });

      return answers.shift() ?? { code: 0, stdout: "", stderr: "" };
    };

    return { runner, seen };
  };

  test("a failed upload is made once more", async () => {
    const local = join(root, "train.jsonl");
    writeFileSync(local, "x".repeat(3_000_000));
    const { runner, seen } = recording([{ code: 1, stdout: "", stderr: "hub closed" }, { code: 0, stdout: "", stderr: "" }]);

    const carried = await nodeCalls(runner, CONSOLE, "alpha").upload(local, "/srv/trainer/a-project/train.jsonl");

    expect(carried.code).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.argv).toEqual(["bun", CONSOLE, "upload", local, "/srv/trainer/a-project/train.jsonl", "-a", "alpha"]);
  });

  test("a transfer failed twice says it was the second time", async () => {
    const { runner, seen } = recording([{ code: 1, stdout: "", stderr: "a" }, { code: 1, stdout: "", stderr: "b" }]);

    const brought = await nodeCalls(runner, CONSOLE, "alpha").download("/remote.tar", join(root, "here.tar"));

    expect(seen).toHaveLength(2);
    expect(runFault(brought)).toBe("tried 2 times, the last exit code 1 — b");
  });

  test("an upload that went across is made once", async () => {
    const { runner, seen } = recording([]);

    await nodeCalls(runner, CONSOLE, "alpha").upload(join(root, "absent"), "/r");

    expect(seen).toHaveLength(1);
  });

  test("a command is not made twice", async () => {
    const { runner, seen } = recording([{ code: 1, stdout: "", stderr: "" }]);

    await nodeCalls(runner, CONSOLE, "alpha").exec("echo HOME=$HOME");

    expect(seen).toEqual([{ argv: ["bun", CONSOLE, "exec", "-a", "alpha", "echo HOME=$HOME"] }]);
  });
});
