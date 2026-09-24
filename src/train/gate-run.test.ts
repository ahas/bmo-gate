import { describe, expect, test } from "bun:test";

import { asymmetricFlags, lastJsonObject, nextMove, parseRunState, runGate } from "./gate-run";

import type { NodeRunner, RunResult } from "../jake";
import type { GateRunOptions } from "./gate-run";

const answer = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

function stateText(changes: Partial<Record<string, string>> = {}): string {
  return Object.entries({
    training: "no", calibrating: "no", finished: "no", exists: "no", step: "none",
    checkpoints: "0", calibrated: "no", lines: "0", last: "none", ...changes,
  }).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

const TRAIN_META = '{"epochs": [{"epoch": 1}], "seconds": 141.2, "steps": 8, "resumes": 1, "micro_batch": 4, "accumulate": 16, '
  + '"precision": "bf16", "device": "RTX 4070", "peak_allocated_bytes": 5100000000, "peak_reserved_bytes": 6790000000}';
const REPORT = '{"after": {"agreement": 0.93, "balanced": 0.84, "ece": 0.047}, "report": {"kind": "laya-calibration", "gates": {}}}';

/** A node that answers the way a real one does, told what its run looks like at each poll. */
function fakeNode(states: readonly string[]): { runner: NodeRunner; commands: string[] } {
  const commands: string[] = [];
  let polled = 0;
  const runner: NodeRunner = async (argv) => {
    const command = argv[2] === "upload" ? `upload ${argv[4]}` : argv[5] ?? "";

    commands.push(command);

    if (command.startsWith("echo HOME")) {
      return answer("HOME=/home/labuser\n");
    }

    if (command.includes(" state ")) {
      polled += 1;

      return answer(states[Math.min(polled - 1, states.length - 1)]!);
    }

    if (command.includes("-calibrate.log")) {
      return answer(REPORT);
    }

    if (command.includes("-train.log")) {
      return answer(TRAIN_META);
    }

    return answer("ok");
  };

  return { runner, commands };
}

function running(runner: NodeRunner, changes: Partial<GateRunOptions> = {}): GateRunOptions {
  return {
    runner, console: "/console", pass: "ref-1-p0001", rehearsal: false, folder: "/data/room-rules", beside: null,
    carryBeside: async () => null,
    collect: async (ask) => ({ folder: `/collected/${ask.gate}/${ask.step}` }),
    wait: async () => {}, polls: 4, everyMs: 1, now: () => new Date("2026-09-25T00:00:00Z"),
    ...changes,
  };
}

describe("the node's answers", () => {
  test("a state is read line by line, and what to do next follows from it alone", () => {
    const state = parseRunState(stateText({ step: "step-000025", exists: "yes" }))!;

    expect(state.step).toBe(25);
    expect(nextMove(state, true)).toBe("resume");
    expect(nextMove({ ...state, step: null }, true)).toBe("stuck");
    expect(nextMove({ ...state, finished: true }, true)).toBe("calibrate");
    expect(parseRunState("nothing")).toBeNull();
  });

  test("the last object a log ends with is what the run came to, braces inside strings and all", () => {
    expect(lastJsonObject('noise {"a": 1}\n{"path": "x}y", "b": {"c": 2}}\n')).toEqual({ path: "x}y", b: { c: 2 } });
  });

  test("a gate's own declaration is what says which answer it may settle", () => {
    expect(asymmetricFlags("reply-wanted")).toEqual(["--asymmetric reply-wanted:forBmo:false"]);
    expect(asymmetricFlags("room-rules")).toEqual([]);
  });
});

describe("runGate", () => {
  test("puts the data across once, launches, calibrates, collects and records what it came to", async () => {
    const { runner, commands } = fakeNode([
      stateText(),
      stateText({ training: "yes", exists: "yes", lines: "3" }),
      stateText({ finished: "yes", exists: "yes", lines: "9" }),
      stateText({ finished: "yes", exists: "yes", calibrating: "yes", lines: "9" }),
      stateText({ finished: "yes", exists: "yes", calibrated: "yes", lines: "9" }),
    ]);
    const row = await runGate("room-rules", "n2", 1, running(runner));

    expect(row.state).toBe("done");
    expect(commands.filter((one) => one.startsWith("upload"))).toHaveLength(3);
    expect(commands.some((one) => one.includes(" launch data/ref-1-p0001-room-rules "))).toBe(true);
    expect(row).toMatchObject({ steps: 8, effectiveBatch: 64, calibration: { agreement: 0.93, balanced: 0.84, ece: 0.047 } });
    expect(row.collected).toEqual(["/collected/room-rules/8"]);
  });

  test("measures the new checkpoint beside the one serving the gate, carried to the node first", async () => {
    const { runner, commands } = fakeNode([stateText({ finished: "yes", exists: "yes" }), stateText({ finished: "yes", exists: "yes", calibrated: "yes" })]);
    const carried: string[] = [];
    const row = await runGate("room-rules", "n3", 1, running(runner, {
      beside: "room-rules/real-1-hand/step-000044",
      carryBeside: async (node, checkpoint) => { carried.push(`${node} ${checkpoint}`); return null; },
    }));

    expect(carried).toEqual(["n3 room-rules/real-1-hand/step-000044"]);
    expect(commands.find((one) => one.includes(" calibrate "))).toContain("--base ~/bmo-laya/beside/checkpoints/room-rules/real-1-hand/step-000044");
    expect(row.beside).toBe("room-rules/real-1-hand/step-000044");
  });

  test("measures beside the checkpoint it came from where the serving one could not be carried, and says so", async () => {
    const { runner, commands } = fakeNode([stateText({ finished: "yes", exists: "yes" }), stateText({ finished: "yes", exists: "yes", calibrated: "yes" })]);
    const row = await runGate("room-rules", "n3", 1, running(runner, { beside: "room-rules/x/step-000001", carryBeside: async () => "hub refused" }));

    expect(commands.find((one) => one.includes(" calibrate "))).not.toContain("--base");
    expect(row.beside).toBeNull();
  });

  test("carries a dead run's newest step back before carrying the run on from it", async () => {
    const { runner, commands } = fakeNode([
      stateText({ exists: "yes", step: "step-000025" }),
      stateText({ finished: "yes", exists: "yes" }),
      stateText({ finished: "yes", exists: "yes", calibrated: "yes" }),
    ]);
    const collected: string[] = [];
    const row = await runGate("room-rules", "n2", 1, running(runner, {
      collect: async (ask) => { collected.push(`${ask.kind} ${ask.step}`); return { folder: "f" }; },
    }));

    expect(row.resumes).toBe(1);
    expect(collected[0]).toBe("step 25");
    expect(commands.some((one) => one.includes(" resume checkpoints/ref-1-p0001-room-rules "))).toBe(true);
  });

  test("gives a run up once nothing about it has moved for the whole bound", async () => {
    const { runner } = fakeNode([stateText({ training: "yes", exists: "yes", lines: "3", last: "epoch 1" })]);
    const row = await runGate("room-rules", "n2", 1, running(runner));

    expect(row.state).toBe("failed");
    expect(row.fault).toContain("마지막 줄: epoch 1");
  });

  test("names a directory with nothing to carry on from rather than writing over it", async () => {
    const { runner } = fakeNode([stateText({ exists: "yes" })]);

    expect((await runGate("room-rules", "n2", 1, running(runner))).fault).toContain("함부로 지우지 않아요");
  });
});
