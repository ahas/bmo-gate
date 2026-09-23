import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { scratchDir } from "./scratch";

import { claimGate, claimsIn, releaseGate, writerAlive } from "./gate-claim";

// Asked for at the one door, which registers its removal as it hands it over.
function scratch(): string {
  return scratchDir("bmo-gate-claim-");
}

// Two writers standing in for two runs sharing a run folder. Neither is this process, so nothing
// here depends on what process ids the machine happens to hand out.
const living = new Set([101, 102]);
const alive = (pid: number): boolean => living.has(pid);

describe("claiming a gate", () => {
  test("an unclaimed gate is this writer's to write", () => {
    const folder = scratch();

    expect(claimGate(folder, { pid: 101, now: 1_000, alive })).toBeNull();
  });

  test("the claim stands in the folder under the writer's own name", () => {
    const folder = scratch();

    claimGate(folder, { pid: 101, now: 1_000, alive });

    expect(claimsIn(folder)).toEqual([{ pid: 101, since: 1_000, name: ".writer.1000.101" }]);
  });

  test("a folder that does not exist yet is made", () => {
    const folder = join(scratch(), "gates", "sanitizer");

    expect(claimGate(folder, { pid: 101, now: 1_000, alive })).toBeNull();
    expect(existsSync(folder)).toBe(true);
  });

  test("the claim is hidden, so a refusal listing what stands in a folder never names it", () => {
    const folder = scratch();

    claimGate(folder, { pid: 101, now: 1_000, alive });

    expect(readdirSync(folder).filter((name) => !name.startsWith("."))).toEqual([]);
  });
});

describe("two runs reaching for the same gate", () => {
  test("the later writer is refused and its claim is taken back", () => {
    const folder = scratch();

    claimGate(folder, { pid: 101, now: 1_000, alive });

    const refusal = claimGate(folder, { pid: 102, now: 2_000, alive });

    expect(refusal).toContain("pid 101");
    expect(claimsIn(folder).map((one) => one.pid)).toEqual([101]);
  });

  test("the elder holds the gate however the two arrived", () => {
    const folder = scratch();

    // The one that laid its claim down second reaches the folder first, and still stands down.
    writeFileSync(join(folder, ".writer.1000.101"), "");

    expect(claimGate(folder, { pid: 102, now: 2_000, alive })).not.toBeNull();
    expect(claimGate(folder, { pid: 101, now: 1_000, alive })).toBeNull();
  });

  test("a dead heat is refused both ways rather than handed to two writers", () => {
    const folder = scratch();

    writeFileSync(join(folder, ".writer.1000.101"), "");

    expect(claimGate(folder, { pid: 102, now: 1_000, alive })).not.toBeNull();
  });

  test("a second gate is not held by the first gate's claim", () => {
    const root = scratch();

    expect(claimGate(join(root, "sanitizer"), { pid: 101, now: 1_000, alive })).toBeNull();
    expect(claimGate(join(root, "room-rules"), { pid: 102, now: 2_000, alive })).toBeNull();
  });
});

describe("a claim its writer left behind", () => {
  test("a claim whose writer is gone is no claim, and the next run takes it", () => {
    const folder = scratch();

    writeFileSync(join(folder, ".writer.1000.999"), "");

    expect(claimGate(folder, { pid: 101, now: 2_000, alive })).toBeNull();
    expect(claimsIn(folder).map((one) => one.pid)).toEqual([101]);
  });

  test("a gate given up is free at once, without waiting for anything to go stale", () => {
    const folder = scratch();

    claimGate(folder, { pid: 101, now: 1_000, alive });
    releaseGate(folder, { pid: 101 });

    expect(claimsIn(folder)).toEqual([]);
    expect(claimGate(folder, { pid: 102, now: 2_000, alive })).toBeNull();
  });

  test("giving up takes back this writer's claim and leaves the other's standing", () => {
    const folder = scratch();

    writeFileSync(join(folder, ".writer.1000.101"), "");
    writeFileSync(join(folder, ".writer.2000.102"), "");

    releaseGate(folder, { pid: 102 });

    expect(claimsIn(folder).map((one) => one.pid)).toEqual([101]);
  });
});

describe("what is read as a claim", () => {
  test("a file that is not a claim is not read as one", () => {
    const folder = scratch();

    for (const name of [".writer", ".writer.what.ever", ".writing", "train.jsonl", ".progress.json.writing"]) {
      writeFileSync(join(folder, name), "");
    }

    expect(claimsIn(folder)).toEqual([]);
  });

  test("a folder that does not exist holds no claims", () => {
    expect(claimsIn(join(scratch(), "nothing-is-here"))).toEqual([]);
  });

  test("this process is alive and a process id nothing runs under is not", () => {
    expect(writerAlive(process.pid)).toBe(true);
    expect(writerAlive(0x7fff_ffff)).toBe(false);
  });
});
