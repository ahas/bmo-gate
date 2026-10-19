import { describe, expect, test } from "bun:test";

import { busyWith, quietMemoryBytes, waitQuiet } from "../../../training/tooling/src/train/quiet";

const plenty = quietMemoryBytes * 2;

describe("busyWith", () => {
  test("a job spared by its unit, with or without the suffix, keeps nothing busy", () => {
    const units = ["bmo.service", "bmo-task-7.service"];

    expect(busyWith({ units, availableBytes: plenty }, ["bmo-task-7"])).toEqual([]);
    expect(busyWith({ units, availableBytes: plenty }, ["bmo-task-7.service"])).toEqual([]);
    expect(busyWith({ units, availableBytes: plenty }, [])).toHaveLength(1);
  });

  test("another training and short memory each keep it busy", () => {
    const busy = busyWith({ units: ["bmo-gate-train.service"], availableBytes: quietMemoryBytes - 1 }, []);

    expect(busy).toHaveLength(2);
    expect(busy.join("\n")).toContain("bmo-gate-train.service");
    expect(busyWith({ units: ["bmo-gate-train.service"], availableBytes: plenty }, ["bmo-gate-train"])).toEqual([]);
    expect(busyWith({ units: [], availableBytes: plenty }, [], plenty + 1)).toHaveLength(1);
  });
});

describe("waitQuiet", () => {
  test("waits reading after reading until the machine is quiet, and says so on the first and every nth", async () => {
    const readings = [["bmo-task-1.service"], ["bmo-task-1.service"], ["bmo-task-1.service"], []];
    const said: string[] = [];
    let waits = 0;

    const waited = await waitQuiet({
      spare: [],
      read: () => ({ units: readings.shift()!, availableBytes: plenty }),
      wait: async () => { waits += 1; },
      say: (line) => said.push(line),
      everyMs: 1000,
      sayEvery: 2,
    });

    expect(waits).toBe(3);
    expect(waited).toBe(3000);
    expect(said.filter((line) => line.includes("waiting for"))).toHaveLength(2);
    expect(said.at(-1)).toContain("going on");
  });
});
