import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COMMAND_LIMIT, nodeCalls, runFault, spawnRunner, transferLimit } from "./jake";
import { scratchDir } from "./scratch";

import type { NodeRunner, RunLimit, RunResult } from "./jake";

const root = scratchDir("bmo-jake-");
const CONSOLE = "/home/ahas/repos/ahas/jake/src/console/main.ts";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

describe("a call that outlives its limit", () => {
  test("a transfer standing silent is killed and says the limit and the bytes it carried", async () => {
    const pidFile = join(root, "stalled.pid");

    const result = await spawnRunner(["sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`], { ms: 200, bytes: 55_000_000 });
    const pid = Number(readFileSync(pidFile, "utf8").trim());

    expect(result.code).not.toBe(0);
    expect(result.timedOut).toEqual({ seconds: 0, bytes: 55_000_000 });
    expect(alive(pid)).toBe(false);
    expect(runFault(result)).toBe("시간 초과(0초, 55,000,000바이트), 출력 없음");
  });

  test("a command is measured by what it had answered", async () => {
    const result = await spawnRunner(["sh", "-c", "printf half; exec sleep 30"], { ms: 200, bytes: null });

    expect(result.timedOut).toEqual({ seconds: 0, bytes: 4 });
    expect(runFault(result)).toBe("시간 초과(0초, 4바이트) — half");
  });

  test("a call inside its limit is left alone", async () => {
    const result = await spawnRunner(["sh", "-c", "echo fine"], { ms: 10_000, bytes: null });

    expect(result).toEqual({ code: 0, stdout: "fine\n", stderr: "" });
  });
});

describe("the limits", () => {
  test("a transfer's limit grows with what it carries", () => {
    expect(transferLimit(0).ms).toBe(60_000);
    expect(transferLimit(55_000_000).ms).toBe(115_000);
    expect(transferLimit(678_000_000).ms).toBe(738_000);
  });

  test("a command outlasts the hub's own five minutes by one", () => {
    expect(COMMAND_LIMIT).toEqual({ ms: 360_000, bytes: null });
  });
});

describe("why a call failed", () => {
  test("the exit code and stderr, falling back to stdout", () => {
    expect(runFault({ code: 2, stdout: "", stderr: "no such file\n" })).toBe("종료 코드 2 — no such file");
    expect(runFault({ code: 1, stdout: "refused\n", stderr: "" })).toBe("종료 코드 1 — refused");
  });

  test("a call that wrote nothing is never a blank", () => {
    expect(runFault({ code: 143, stdout: "", stderr: "" })).toBe("종료 코드 143, 출력 없음");
  });
});

describe("the calls on one node", () => {
  const recording = (answers: RunResult[]) => {
    const seen: Array<{ argv: readonly string[]; limit: RunLimit | undefined }> = [];
    const runner: NodeRunner = async (argv, limit) => {
      seen.push({ argv, limit });

      return answers.shift() ?? { code: 0, stdout: "", stderr: "" };
    };

    return { runner, seen };
  };

  test("an upload is limited by the file's size, and a failed one is made once more", async () => {
    const local = join(root, "train.jsonl");
    writeFileSync(local, "x".repeat(3_000_000));
    const { runner, seen } = recording([{ code: 1, stdout: "", stderr: "hub closed" }, { code: 0, stdout: "", stderr: "" }]);

    const carried = await nodeCalls(runner, CONSOLE, "n2").upload(local, "/home/labuser/bmo-laya/train.jsonl");

    expect(carried.code).toBe(0);
    expect(seen.map((one) => one.limit)).toEqual([{ ms: 63_000, bytes: 3_000_000 }, { ms: 63_000, bytes: 3_000_000 }]);
    expect(seen[0]!.argv).toEqual(["bun", CONSOLE, "upload", local, "/home/labuser/bmo-laya/train.jsonl", "-a", "n2"]);
  });

  test("a transfer failed twice says it was the second time", async () => {
    const { runner, seen } = recording([{ code: 1, stdout: "", stderr: "a" }, { code: 1, stdout: "", stderr: "b" }]);

    const brought = await nodeCalls(runner, CONSOLE, "n2").download("/remote.tar", join(root, "here.tar"), 678_000_000);

    expect(seen).toHaveLength(2);
    expect(runFault(brought)).toBe("2번 해 봤어요, 마지막은 종료 코드 1 — b");
  });

  test("an upload that went across is made once", async () => {
    const { runner, seen } = recording([]);

    await nodeCalls(runner, CONSOLE, "n2").upload(join(root, "absent"), "/r");

    expect(seen).toHaveLength(1);
  });

  test("a command is not made twice and carries the command limit", async () => {
    const { runner, seen } = recording([{ code: 1, stdout: "", stderr: "" }]);

    await nodeCalls(runner, CONSOLE, "n2").exec("echo HOME=$HOME");

    expect(seen).toEqual([{ argv: ["bun", CONSOLE, "exec", "-a", "n2", "echo HOME=$HOME"], limit: COMMAND_LIMIT }]);
  });
});
