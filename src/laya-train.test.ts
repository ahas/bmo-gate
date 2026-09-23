import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitFiles } from "./laya-frozen";
import {
  asymmetricFlags,
  calibrateCommand,
  calibrateLogOnNode,
  checkpointOnNode,
  dataOnNode,
  driveGate,
  driveRun,
  launchCommand,
  ledgerFromMeta,
  ledgerFromReport,
  trainLedgerLines,
  lastJsonObject,
  nextMove,
  planRounds,
  parseRunState,
  readTrainLedger,
  reportOf,
  resumeCommand,
  stateCommand,
  trainLogOnNode,
  writeGateDataset,
  writeTrainLedger,
  type DriveOptions,
  type TrainLedger,
  type RunState,
} from "./laya-train";

import { scratchDir } from "./scratch";

import type { NodeRunner, RunResult } from "./laya-nodes";

const CONSOLE = "/home/ahas/repos/ahas/infra/jake/src/console/main.ts";

// One directory for the file, asked for at the one door that takes it away again, and a room of its
// own under it for each case.
const root = scratchDir("bmo-laya-train-");
let made = 0;

function folder(): string {
  made += 1;
  const where = join(root, `case-${made}`);

  mkdirSync(where, { recursive: true });

  return where;
}

const answer = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

function stateText(changes: Partial<Record<string, string>> = {}): string {
  return Object.entries({
    training: "no", calibrating: "no", finished: "no", exists: "no", step: "none",
    checkpoints: "0", calibrated: "no", lines: "0", last: "none", ...changes,
  }).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

const TRAIN_META = '{"base": "/hub", "items": {"reply-wanted": 44}, "epochs": [{"epoch": 1}, {"epoch": 2}], '
  + '"seconds": 141.2, "steps": 8, "resumes": 1, "balance_ratio": 3.0, "micro_batch": 4, "accumulate": 16, '
  + '"precision": "bf16", "seed": 42, "device": "NVIDIA GeForce RTX 4070", "peak_allocated_bytes": 5100000000, '
  + '"peak_reserved_bytes": 6790000000}';

const REPORT = '{\n  "model": "checkpoints/x",\n  "after": {\n    "agreement": 0.93,\n    "balanced": 0.84,\n'
  + '    "ece": 0.047\n  },\n  "written": true,\n  "report": {\n    "kind": "laya-calibration",\n'
  + '    "gates": {"reply-wanted": {"agreement": 0.93, "difference": {"agreement": 0.41}}}\n  }\n}';

interface Seen {
  argv: readonly string[];
  command: string;
}

/** A node that answers the way a real one does, told what its run looks like at each poll. */
function fakeNode(states: readonly string[], logs: { train?: string; calibrate?: string } = {}): { runner: NodeRunner; seen: Seen[] } {
  const seen: Seen[] = [];
  let asked = 0;
  const runner: NodeRunner = async (argv) => {
    const command = argv[5] ?? "";

    seen.push({ argv, command });

    if (command.startsWith("echo HOME")) {
      return answer("HOME=/home/labuser\n");
    }
    if (argv[2] === "upload") {
      return answer("uploaded");
    }
    if (command.includes(" state ")) {
      const said = states[Math.min(asked, states.length - 1)]!;

      asked += 1;

      return answer(said);
    }
    if (command.includes("-calibrate.log")) {
      return answer(logs.calibrate ?? "");
    }
    if (command.includes("-train.log")) {
      return answer(logs.train ?? "");
    }

    return answer("launched pid=1234");
  };

  return { runner, seen };
}

const driving = (runner: NodeRunner, changes: Partial<DriveOptions> = {}): DriveOptions => ({
  runner,
  console: CONSOLE,
  dataset: "rehearsal-713",
  gateFolders: { "reply-wanted": "/checkout-data/gates/reply-wanted" },
  rehearsal: true,
  wait: async () => {},
  polls: 6,
  everyMs: 1,
  now: () => new Date("2026-09-23T08:00:00Z"),
  ...changes,
});

const commands = (seen: Seen[]) => seen.map((one) => one.command);
const did = (seen: Seen[], what: string) => commands(seen).some((command) => command.includes(what));

describe("dealing the gates out", () => {
  test("ten gates over five nodes are two rounds, one gate to a node", () => {
    const rounds = planRounds(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], ["n2", "n3", "n4", "n5", "n6"]);

    expect(rounds.length).toBe(2);
    expect(rounds[0]).toEqual([
      { gate: "a", node: "n2" }, { gate: "b", node: "n3" }, { gate: "c", node: "n4" },
      { gate: "d", node: "n5" }, { gate: "e", node: "n6" },
    ]);
    expect(rounds[1]!.map((one) => one.gate)).toEqual(["f", "g", "h", "i", "j"]);
    for (const round of rounds) {
      expect(new Set(round.map((one) => one.node)).size).toBe(round.length);
    }
  });

  test("fewer gates than nodes is one round, and a node is left idle", () => {
    expect(planRounds(["a", "b"], ["n2", "n3", "n4"])).toEqual([[{ gate: "a", node: "n2" }, { gate: "b", node: "n3" }]]);
  });

  test("no node is no round at all", () => {
    expect(planRounds(["a"], [])).toEqual([]);
  });
});

describe("one gate's own data", () => {
  test("a gate is given its rows and nobody else's", () => {
    const from = folder();
    const to = folder();

    try {
      for (const [split, name] of Object.entries(splitFiles)) {
        writeFileSync(join(from, name), [
          JSON.stringify({ id: `a-${split}`, gate: "reply-wanted", split }),
          JSON.stringify({ id: `b-${split}`, gate: "sanitizer", split }),
          JSON.stringify({ id: `c-${split}`, gate: "reply-wanted", split }),
        ].join("\n") + "\n");
      }

      const cut = writeGateDataset(from, "reply-wanted", to);

      expect(cut).toEqual({ gate: "reply-wanted", folder: to, rows: { train: 2, calibration: 2, test: 2 } });

      const written = readFileSync(join(to, splitFiles.train), "utf8").split("\n").filter((line) => line !== "");

      expect(written.length).toBe(2);
      expect(written.every((line) => (JSON.parse(line) as { gate: string }).gate === "reply-wanted")).toBe(true);
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });

  test("a gate with an empty split is refused rather than sent to a node", () => {
    const from = folder();
    const to = folder();

    try {
      writeFileSync(join(from, splitFiles.train), `${JSON.stringify({ gate: "reply-wanted", split: "train" })}\n`);
      writeFileSync(join(from, splitFiles.calibration), "");
      writeFileSync(join(from, splitFiles.test), "");

      const cut = writeGateDataset(from, "reply-wanted", to);

      expect(typeof cut).toBe("string");
      expect(cut as string).toContain("calibration");
      expect(cut as string).toContain("test");
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });

  test("a folder short of a split is named", () => {
    const from = folder();

    try {
      expect(typeof writeGateDataset(from, "reply-wanted", folder())).toBe("string");
    } finally {
      rmSync(from, { recursive: true, force: true });
    }
  });
});

describe("the commands a run is made of", () => {
  test("the training is launched detached with its data, its checkpoint and its log", () => {
    const command = launchCommand("rehearsal-713", "reply-wanted", ["--epochs", "2"]);

    expect(command).toContain("node-train.sh launch");
    expect(command).toContain(dataOnNode("rehearsal-713", "reply-wanted"));
    expect(command).toContain(checkpointOnNode("rehearsal-713", "reply-wanted"));
    expect(command).toContain(trainLogOnNode("rehearsal-713", "reply-wanted"));
    expect(command).toContain("--epochs 2");
  });

  test("a resume names the checkpoint to carry on from, not the base", () => {
    const command = resumeCommand("rehearsal-713", "reply-wanted", []);

    expect(command).toContain("node-train.sh resume");
    expect(command).toContain(checkpointOnNode("rehearsal-713", "reply-wanted"));
    expect(command).not.toContain("--base");
  });

  test("the calibration reads the checkpoint and the same data", () => {
    const command = calibrateCommand("rehearsal-713", "reply-wanted");

    expect(command).toContain("node-train.sh calibrate");
    expect(command).toContain(calibrateLogOnNode("rehearsal-713", "reply-wanted"));
  });

  test("the state asks about the checkpoint and its log", () => {
    expect(stateCommand("rehearsal-713", "reply-wanted")).toContain("node-train.sh state");
  });
});

describe("reading what a node says about a run", () => {
  test("every field comes back typed", () => {
    const state = parseRunState(stateText({ training: "yes", exists: "yes", step: "step-000025", checkpoints: "2", lines: "40", last: "epoch 2/4" }))!;

    expect(state).toEqual({
      training: true, calibrating: false, finished: false, exists: true, calibrated: false, step: 25,
      checkpoints: 2, lines: 40, last: "epoch 2/4",
    } satisfies RunState);
  });

  test("a run that never started says so without a step", () => {
    expect(parseRunState(stateText())!.step).toBeNull();
  });

  test("an answer that is not a state is not read as one", () => {
    expect(parseRunState("bash: node-train.sh: No such file or directory")).toBeNull();
    expect(parseRunState("")).toBeNull();
  });
});

describe("what to do next", () => {
  const state = (changes: Partial<RunState>): RunState => ({
    training: false, calibrating: false, finished: false, exists: false, calibrated: false, step: null,
    checkpoints: 0, lines: 0, last: "none", ...changes,
  });

  test("nothing there yet and the data across: start it", () => {
    expect(nextMove(state({}), true)).toBe("launch");
  });

  test("going: leave it alone", () => {
    expect(nextMove(state({ training: true }), true)).toBe("wait");
  });

  test("dead with a step checkpoint: carry it on", () => {
    expect(nextMove(state({ exists: true, step: 25, checkpoints: 2 }), true)).toBe("resume");
  });

  test("dead with nothing to carry on from: named, not written over", () => {
    expect(nextMove(state({ exists: true }), true)).toBe("stuck");
  });

  test("finished: calibrate it", () => {
    expect(nextMove(state({ finished: true, exists: true, step: 40 }), true)).toBe("calibrate");
  });

  test("finished and calibrating: leave it alone", () => {
    expect(nextMove(state({ finished: true, calibrating: true, exists: true }), true)).toBe("wait");
  });

  test("no data across and nothing there: there is nothing to start", () => {
    expect(nextMove(state({}), false)).toBe("stuck");
  });
});

describe("the last JSON a log ends with", () => {
  test("the training's own meta is read whole", () => {
    const read = lastJsonObject(`epoch 1/4: 34.1s\nitems: 44\n${TRAIN_META}\n`);

    expect(read?.steps).toBe(8);
    expect(read?.micro_batch).toBe(4);
  });

  test("a brace inside a name does not end the object early", () => {
    const read = lastJsonObject('note\n{"model": "checkpoints/{odd}-name", "after": {"ece": 0.1}}\n');

    expect(read?.model).toBe("checkpoints/{odd}-name");
    expect((read?.after as { ece: number }).ece).toBe(0.1);
  });

  test("a log with no JSON in it reads as none", () => {
    expect(lastJsonObject("Traceback (most recent call last):\n  RuntimeError: CUDA out of memory\n")).toBeNull();
  });

  test("the last one is the one read", () => {
    expect(lastJsonObject('{"steps": 1}\n{"steps": 2}\n')?.steps).toBe(2);
  });
});

describe("the ledger", () => {
  test("the training's meta becomes the row's own figures", () => {
    const row = ledgerFromMeta(lastJsonObject(TRAIN_META));

    expect(row.steps).toBe(8);
    expect(row.resumes).toBe(1);
    expect(row.epochs).toBe(2);
    expect(row.seconds).toBe(141.2);
    expect(row.peakReservedBytes).toBe(6_790_000_000);
    expect(row.microBatch).toBe(4);
    expect(row.accumulate).toBe(16);
    expect(row.effectiveBatch).toBe(64);
    expect(row.precision).toBe("bf16");
    expect(row.device).toBe("NVIDIA GeForce RTX 4070");
  });

  test("a run that said nothing leaves the figures empty rather than guessed", () => {
    expect(ledgerFromMeta(null)).toEqual({});
  });

  test("the calibration's three figures are kept", () => {
    expect(ledgerFromReport(lastJsonObject(REPORT))).toEqual({ agreement: 0.93, balanced: 0.84, ece: 0.047 });
    expect(ledgerFromReport(null)).toBeNull();
    expect(ledgerFromReport({ model: "x" })).toBeNull();
  });

  test("the whole machine-readable report rides in the row, so no table needs a second transfer", () => {
    const report = reportOf(lastJsonObject(REPORT))!;

    expect((report.gates as Record<string, { agreement: number }>)["reply-wanted"]!.agreement).toBe(0.93);
    expect(reportOf({ model: "x" })).toBeNull();
    expect(reportOf({ report: { kind: "something-else" } })).toBeNull();
    expect(reportOf(null)).toBeNull();
  });

  test("a gate's own declaration of what Laya may settle becomes the measurement's flag", () => {
    expect(asymmetricFlags("reply-wanted")).toEqual(["--asymmetric reply-wanted:forBmo:false"]);
    expect(asymmetricFlags("content-judge")).toEqual(["--asymmetric content-judge:keeps:true"]);
    expect(asymmetricFlags("system-documents")).toEqual([]);
    expect(asymmetricFlags("not-a-gate")).toEqual([]);
    expect(calibrateCommand("run", "reply-wanted", asymmetricFlags("reply-wanted")))
      .toContain("--asymmetric reply-wanted:forBmo:false");
  });

  test("it is written and read back", () => {
    const where = folder();

    try {
      const ledger: TrainLedger = {
        run: "rehearsal-713", dataset: "rehearsal-713", rehearsal: true,
        started: "2026-09-23T08:00:00Z", ended: "2026-09-23T08:20:00Z", nodes: ["n2"],
        rows: [{
          gate: "reply-wanted", node: "n2", round: 1, dataset: "rehearsal-713", rehearsal: true, state: "done",
          startedAt: "2026-09-23T08:00:00Z", endedAt: "2026-09-23T08:10:00Z", steps: 8, epochs: 2, resumes: 1,
          seconds: 141.2, peakReservedBytes: 6_790_000_000, peakAllocatedBytes: 5_100_000_000, microBatch: 4,
          accumulate: 16, effectiveBatch: 64, precision: "bf16", device: "RTX 4070", items: { "reply-wanted": 44 },
          checkpoint: "checkpoints/rehearsal-713-reply-wanted", trainLog: null, calibrateLog: null,
          calibration: { agreement: 0.93, balanced: 0.84, ece: 0.047 }, report: null, collected: [], collectFault: null, fault: null,
        }],
      };

      writeTrainLedger(where, ledger);

      expect(readTrainLedger(where)).toEqual(ledger);

      const lines = trainLedgerLines(ledger).join("\n");

      expect(lines).toContain("reply-wanted");
      expect(lines).toContain("n2");
      expect(lines).toContain("6.79 GB");
      expect(lines).toContain("4×16=64");
      expect(lines).toContain("bf16");
      expect(lines).toContain("리허설");
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });

  test("a folder with no ledger in it reads as none", () => {
    const where = folder();

    try {
      expect(readTrainLedger(where)).toBeNull();
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });
});

describe("driving one gate", () => {
  test("a clean node is given the data, then the training, then the calibration", async () => {
    const { runner, seen } = fakeNode([
      stateText(),
      stateText({ training: "yes", exists: "yes" }),
      stateText({ finished: "yes", exists: "yes", step: "step-000008" }),
      stateText({ finished: "yes", calibrating: "yes", exists: "yes", step: "step-000008" }),
      stateText({ finished: "yes", exists: "yes", step: "step-000008" }),
    ], { train: TRAIN_META, calibrate: REPORT });

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner));

    expect(row.state).toBe("done");
    expect(row.fault).toBeNull();
    expect(row.steps).toBe(8);
    expect(row.calibration).toEqual({ agreement: 0.93, balanced: 0.84, ece: 0.047 });
    expect(row.precision).toBe("bf16");
    expect(seen.filter((one) => one.argv[2] === "upload").length).toBe(3);
    expect(did(seen, "node-train.sh launch")).toBe(true);
    expect(did(seen, "node-train.sh calibrate")).toBe(true);
  });

  test("a run that died is carried on from its step checkpoint, not from the base", async () => {
    const { runner, seen } = fakeNode([
      stateText({ training: "yes", exists: "yes", step: "step-000025" }),
      stateText({ exists: "yes", step: "step-000025", last: "Killed" }),
      stateText({ training: "yes", exists: "yes", step: "step-000025" }),
      stateText({ finished: "yes", exists: "yes", step: "step-000040" }),
      stateText({ finished: "yes", exists: "yes", step: "step-000040" }),
    ], { train: TRAIN_META, calibrate: REPORT });

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner));

    expect(row.state).toBe("done");
    expect(row.resumes).toBe(1);
    expect(did(seen, "node-train.sh resume")).toBe(true);
    expect(did(seen, "node-train.sh launch")).toBe(false);
    // The data was already there, so nothing was put across a second time: a resume is bound to the
    // very file it started on.
    expect(seen.filter((one) => one.argv[2] === "upload").length).toBe(0);
  });

  test("a run that keeps dying is given up on and says how often it was tried", async () => {
    const { runner } = fakeNode([stateText({ exists: "yes", step: "step-000010", last: "Killed" })], { train: TRAIN_META });

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner, { maxResumes: 2 }));

    expect(row.state).toBe("failed");
    expect(row.fault).toContain("2번");
    expect(row.resumes).toBe(2);
  });

  test("a training that falls over as it starts is not started again and again", async () => {
    const { runner, seen } = fakeNode([stateText({ last: "ModuleNotFoundError: laya" })]);

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner));

    expect(row.state).toBe("failed");
    expect(row.fault).toContain("시작되자마자");
    expect(commands(seen).filter((one) => one.includes("node-train.sh launch")).length).toBe(1);
  });

  test("a directory with nothing to carry on from is named rather than written over", async () => {
    const { runner, seen } = fakeNode([stateText({ exists: "yes" })]);

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner));

    expect(row.state).toBe("failed");
    expect(row.fault).toContain("지우세요");
    expect(did(seen, "node-train.sh launch")).toBe(false);
  });

  test("a node that does not answer is said to be out of reach", async () => {
    const runner: NodeRunner = async () => answer("", 255);

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner));

    expect(row.state).toBe("unreachable");
    expect(row.fault).toContain("노드가 답하지 않아요");
  });

  test("a calibration that left no figures is not called done", async () => {
    const { runner } = fakeNode([
      stateText({ finished: "yes", exists: "yes", step: "step-000008" }),
      stateText({ finished: "yes", exists: "yes", step: "step-000008", calibrated: "yes" }),
    ], { train: TRAIN_META, calibrate: "Traceback (most recent call last):\nRuntimeError: no calibration rows" });

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner));

    expect(row.state).toBe("failed");
    expect(row.fault).toContain("보정");
  });

  test("a run already finished and already calibrated is read, not run again", async () => {
    const { runner, seen } = fakeNode([
      stateText({ finished: "yes", exists: "yes", step: "step-000008", calibrated: "yes" }),
    ], { train: TRAIN_META, calibrate: REPORT });

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner));

    expect(row.state).toBe("done");
    expect(did(seen, "node-train.sh calibrate")).toBe(false);
    expect(did(seen, "node-train.sh launch")).toBe(false);
  });

  test("a run that never finishes is not waited on for ever", async () => {
    const { runner } = fakeNode([stateText({ training: "yes", exists: "yes", last: "epoch 1/4" })]);

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner, { polls: 3 }));

    expect(row.state).toBe("failed");
    expect(row.fault).toContain("끝나지 않았어요");
  });
});

describe("carrying the checkpoints off the node", () => {
  test("a run that finished has its own checkpoint carried back", async () => {
    const asked: Array<{ gate: string; node: string; step: number; kind: string; source: string }> = [];
    const { runner } = fakeNode([
      stateText({ finished: "yes", exists: "yes", step: "step-000008" }),
      stateText({ finished: "yes", exists: "yes", step: "step-000008", calibrated: "yes" }),
    ], { train: TRAIN_META, calibrate: REPORT });

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner, {
      collect: async (ask) => {
        asked.push(ask);

        return { folder: `/collection/${ask.gate}/step-${ask.step}` };
      },
    }));

    expect(row.state).toBe("done");
    expect(asked).toEqual([{
      gate: "reply-wanted", node: "n2", step: 8, kind: "final",
      source: "checkpoints/rehearsal-713-reply-wanted",
    }]);
    expect(row.collected).toEqual(["/collection/reply-wanted/step-8"]);
    expect(row.collectFault).toBeNull();
  });

  test("a run found dead has its newest step carried back before it is carried on", async () => {
    const asked: Array<{ step: number; kind: string; source: string }> = [];
    const { runner } = fakeNode([
      stateText({ exists: "yes", step: "step-000025", last: "Killed" }),
      stateText({ training: "yes", exists: "yes", step: "step-000025" }),
      stateText({ finished: "yes", exists: "yes", step: "step-000040" }),
      stateText({ finished: "yes", exists: "yes", step: "step-000040", calibrated: "yes" }),
    ], { train: TRAIN_META, calibrate: REPORT });

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner, {
      collect: async (ask) => {
        asked.push(ask);

        return { folder: `/collection/step-${ask.step}` };
      },
    }));

    expect(row.state).toBe("done");
    expect(asked.map((one) => [one.kind, one.step])).toEqual([["step", 25], ["final", 8]]);
    expect(asked[0]!.source).toBe("checkpoints/rehearsal-713-reply-wanted/steps/step-000025");
    expect(row.collected.length).toBe(2);
  });

  test("a checkpoint that could not be carried back is said, and the training still stands", async () => {
    const { runner } = fakeNode([
      stateText({ finished: "yes", exists: "yes", step: "step-000008" }),
      stateText({ finished: "yes", exists: "yes", step: "step-000008", calibrated: "yes" }),
    ], { train: TRAIN_META, calibrate: REPORT });

    const row = await driveGate("reply-wanted", "n2", 1, driving(runner, {
      collect: async () => "노드가 답하지 않아요",
    }));

    expect(row.state).toBe("done");
    expect(row.collected).toEqual([]);
    expect(row.collectFault).toBe("노드가 답하지 않아요");
  });
});

describe("driving a whole run", () => {
  test("a node out of reach loses its own gate and no other", async () => {
    const runner: NodeRunner = async (argv) => {
      const node = argv[4];
      const command = argv[5] ?? "";

      if (node === "n3") {
        return answer("", 255);
      }
      if (command.startsWith("echo HOME")) {
        return answer("HOME=/home/labuser\n");
      }
      if (command.includes(" state ")) {
        return answer(stateText({ finished: "yes", exists: "yes", step: "step-000008" }));
      }
      if (command.includes("-calibrate.log")) {
        return answer(REPORT);
      }
      if (command.includes("-train.log")) {
        return answer(TRAIN_META);
      }

      return answer("launched");
    };

    const ledger = await driveRun(["a", "b", "c"], ["n2", "n3"], driving(runner, {
      gateFolders: { a: "/x/a", b: "/x/b", c: "/x/c" },
    }));

    expect(ledger.rows.map((row) => [row.gate, row.node, row.state])).toEqual([
      ["a", "n2", "done"], ["b", "n3", "unreachable"], ["c", "n2", "done"],
    ]);
    expect(ledger.rows.map((row) => row.round)).toEqual([1, 1, 2]);
    expect(ledger.rehearsal).toBe(true);
  });
});
