import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { consoleExecArgs, consoleUploadArgs, parseHome } from "../../training/tooling/src/node-calls";
import {
  NODE_FILES,
  cardTaken,
  nodeFileSource,
  nodeBusy,
  nodeFilePath,
  nodePath,
  nodeTable,
  nothingToTrainOn,
  notTrainingNodes,
  outdatedFiles,
  parseProbe,
  parseSetupEnd,
  pinnedLaya,
  printedWidth,
  reachTrainingNodes,
  readiness,
  setupLaunchCommand,
  standNode,
  standNodes,
  TRAINING_PLACEMENT,
  type NodeOutcome,
} from "../../training/tooling/src/laya-nodes";
import { placementPath, readPlacement } from "../../training/tooling/src/placement";
import { scratchDir } from "./scratch";

import type { NodeRunner, RunResult } from "../../training/tooling/src/node-calls";

const CONSOLE = "/opt/console/main.ts";
// The data root the training placement is named under, a scratch one of the test's own.
process.env.BMO_DATA_DIR = scratchDir("bmo-laya-data-");
const REPOSITORY = "/checkout";
// The repository this test stands in, whose node files the probe is run over.
const REPOSITORY_ROOT = join(import.meta.dir, "..", "..");

// What this checkout's files come to, as the probe would report them back.
const digests: Record<string, string> = Object.fromEntries(NODE_FILES.map((name, index) => [name, `sha-${index}`]));

function probeText(changes: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    host: "node3.example.test",
    os: "Ubuntu 22.04.5 LTS",
    kernel: "6.8.0-45-generic",
    gpu: "NVIDIA GeForce RTX 4070",
    vram_total_mb: "12282",
    vram_free_mb: "11874",
    gpu_procs: "0",
    driver: "560.35.03",
    cuda: "12.5",
    cuda_path: "/usr/local/cuda/bin",
    python: "3.10.12",
    cc: "cc 11.4.0",
    uv: "0.12.17",
    disk_free_gb: "199",
    venv_python: "3.12.13",
    venv_managed: "yes",
    "pkg.laya": "0.3.5",
    "pkg.torch": "2.14.0",
    "pkg.transformers": "5.1.0",
    "pkg.safetensors": "0.6.2",
    "pkg.bitsandbytes": "none",
    "pkg.numpy": "2.1.0",
    setup_last: "LAYA-SETUP-DONE ok",
    setup_running: "no",
    ...Object.fromEntries(NODE_FILES.map((name) => [`sha.${name}`, digests[name]!])),
    ...changes,
  };

  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

const answer = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "" });

interface Seen {
  argv: readonly string[];
}

/** A stand-in for the node console: it is told what each kind of call answers, and it keeps every call
 * so a test can say what was never done to a node. */
function fakeRunner(answers: {
  probe: (calls: number) => RunResult;
  upload?: (local: string) => RunResult;
  tail?: (calls: number) => RunResult;
  other?: RunResult;
}): { runner: NodeRunner; seen: Seen[] } {
  const seen: Seen[] = [];
  let probes = 0;
  let tails = 0;
  const runner: NodeRunner = async (argv) => {
    seen.push({ argv });
    const verb = argv[2];
    const command = argv[5] ?? "";
    if (verb === "upload") {
      return answers.upload?.(argv[3]!) ?? answer("uploaded");
    }
    if (command.startsWith("echo HOME")) {
      return answer("HOME=/srv/trainer\n");
    }
    if (command.includes("node-probe.sh")) {
      probes += 1;
      return answers.probe(probes);
    }
    if (command.includes("tail -n")) {
      tails += 1;
      return answers.tail?.(tails) ?? answer("LAYA-SETUP-DONE ok");
    }
    return answers.other ?? answer("");
  };

  return { runner, seen };
}

// The training placement these tests stand in for: four made-up nodes, and none other.
const TRAINING = ["alpha", "bravo", "charlie", "delta"];

const standing = (runner: NodeRunner, check = false) => ({
  runner,
  console: CONSOLE,
  repository: REPOSITORY,
  digests,
  pinned: "0.3.5",
  training: TRAINING,
  check,
  wait: async () => {},
  polls: 4,
  everyMs: 1,
});

const uploads = (seen: Seen[]) => seen.filter((one) => one.argv[2] === "upload").map((one) => one.argv[3]);
const launched = (seen: Seen[]) => seen.some((one) => (one.argv[5] ?? "").includes("node-setup.sh > setup.log"));

describe("the calls a node is reached with", () => {
  test("exec names the agent and carries the command whole", () => {
    expect(consoleExecArgs(CONSOLE, "bravo", "bash ~/bmo-laya/node-probe.sh"))
      .toEqual(["bun", CONSOLE, "exec", "-a", "bravo", "bash ~/bmo-laya/node-probe.sh"]);
  });

  test("upload names the local file, the remote path and the agent", () => {
    expect(consoleUploadArgs(CONSOLE, "charlie", `${REPOSITORY}/training/laya/resume.py`, nodeFilePath("/srv/trainer", "resume.py")))
      .toEqual(["bun", CONSOLE, "upload", `${REPOSITORY}/training/laya/resume.py`, "/srv/trainer/bmo-laya/resume.py", "-a", "charlie"]);
  });

  test("an upload's path is written out whole, since no shell reads it", () => {
    expect(nodeFilePath("/srv/trainer", "finetune.py")).toBe("/srv/trainer/bmo-laya/finetune.py");
    expect(nodeFilePath("/srv/trainer/", "finetune.py")).toBe("/srv/trainer/bmo-laya/finetune.py");
    expect(nodeFilePath("/srv/trainer", "finetune.py")).not.toContain("~");
    expect(nodePath("finetune.py")).toBe("~/bmo-laya/finetune.py");
  });

  test("the home a node says is read, and a node that says none is not guessed at", () => {
    expect(parseHome("HOME=/srv/trainer\n")).toBe("/srv/trainer");
    expect(parseHome("some warning\nHOME=/srv/trainer")).toBe("/srv/trainer");
    expect(parseHome("")).toBeNull();
    expect(parseHome("HOME=\n")).toBeNull();
  });

  test("the setup is detached and its output goes to a log", () => {
    const command = setupLaunchCommand();

    expect(command).toContain("setsid nohup bash node-setup.sh > setup.log 2>&1");
    expect(command).toContain("chmod +x");
  });
});

describe("reading what a node carries", () => {
  test("every reading comes back typed", () => {
    const probe = parseProbe(probeText())!;

    expect(probe.host).toBe("node3.example.test");
    expect(probe.gpu).toBe("NVIDIA GeForce RTX 4070");
    expect(probe.vramTotalMb).toBe(12282);
    expect(probe.gpuProcs).toBe(0);
    expect(probe.cuda).toBe("12.5");
    expect(probe.python).toBe("3.10.12");
    expect(probe.venvPython).toBe("3.12.13");
    expect(probe.packages.laya).toBe("0.3.5");
    expect(probe.packages.bitsandbytes).toBe("none");
    expect(probe.digests["resume.py"]).toBe(digests["resume.py"]);
    expect(probe.diskFreeGb).toBe(199);
    expect(probe.setupRunning).toBe(false);
  });

  test("what is not there comes back as nothing rather than as a number", () => {
    const probe = parseProbe(probeText({ gpu: "none", vram_free_mb: "none", disk_free_gb: "none" }))!;

    expect(probe.gpu).toBe("none");
    expect(probe.vramFreeMb).toBeNull();
    expect(probe.diskFreeGb).toBeNull();
  });

  test("a line that is not the probe's is passed over", () => {
    const probe = parseProbe(`bash: line 1: warning\n${probeText()}Connection to node3 closed.\n`)!;

    expect(probe.host).toBe("node3.example.test");
  });

  test("an answer with no host in it is not a reading", () => {
    expect(parseProbe("bash: /srv/trainer/bmo-laya/node-probe.sh: No such file or directory")).toBeNull();
    expect(parseProbe("")).toBeNull();
  });
});

describe("whether a node can take a gate", () => {
  test("a node with everything is ready", () => {
    expect(readiness(parseProbe(probeText()), "0.3.5", digests)).toEqual({ ready: true, missing: [] });
  });

  test("a venv standing on the system python is not ready, since it builds against headers the node may lack", () => {
    const verdict = readiness(parseProbe(probeText({ venv_managed: "no" })), "0.3.5", digests);

    expect(verdict.ready).toBe(false);
    expect(verdict.missing).toEqual(["its venv stands on the system's python, not uv's"]);
  });

  test("a probe that cannot tell whose python the venv stands on is not held against the node", () => {
    expect(parseProbe(probeText({ venv_managed: "none" }))!.venvManaged).toBeNull();
    expect(readiness(parseProbe(probeText({ venv_managed: "none" })), "0.3.5", digests).ready).toBe(true);
  });

  test("a package that is not there is named", () => {
    const verdict = readiness(parseProbe(probeText({ "pkg.torch": "none" })), "0.3.5", digests);

    expect(verdict.ready).toBe(false);
    expect(verdict.missing.join(" ")).toContain("torch");
  });

  test("laya off its pin is named with both versions", () => {
    const verdict = readiness(parseProbe(probeText({ "pkg.laya": "0.4.0" })), "0.3.5", digests);

    expect(verdict.ready).toBe(false);
    expect(verdict.missing.join(" ")).toContain("0.4.0");
    expect(verdict.missing.join(" ")).toContain("0.3.5");
  });

  test("a file the node has in another shape is named", () => {
    const verdict = readiness(parseProbe(probeText({ "sha.finetune.py": "something-else" })), "0.3.5", digests);

    expect(verdict.ready).toBe(false);
    expect(verdict.missing.join(" ")).toContain("finetune.py");
  });

  test("a card with room to spare and none to spare", () => {
    expect(readiness(parseProbe(probeText({ disk_free_gb: "5" })), "0.3.5", digests).ready).toBe(false);
    expect(readiness(parseProbe(probeText({ disk_free_gb: "199" })), "0.3.5", digests).ready).toBe(true);
  });

  test("a node that did not answer is not ready", () => {
    expect(readiness(null, "0.3.5", digests).ready).toBe(false);
  });

  test("a card without room for a gate is busy", () => {
    expect(nodeBusy(parseProbe(probeText({ gpu_procs: "1", vram_free_mb: "5480" }))!)).toBe(true);
    expect(cardTaken(parseProbe(probeText({ gpu_procs: "1", vram_free_mb: "5480" }))!)).toContain("5480MB");
    expect(nodeBusy(parseProbe(probeText())!)).toBe(false);
  });

  test("a resident process that holds little leaves the card free", () => {
    expect(nodeBusy(parseProbe(probeText({ gpu_procs: "1", vram_free_mb: "12055" }))!)).toBe(false);
  });

  test("where the card arbiter answers, its word decides whatever a resting holder keeps on the card", () => {
    const resting = parseProbe(probeText({ gpu_procs: "1", vram_free_mb: "751", card_busy: "no" }))!;
    expect(resting.cardBusy).toBe(false);
    expect(cardTaken(resting)).toBeNull();
    expect(readiness(resting, "0.3.5", digests).ready).toBe(true);
    expect(cardTaken(parseProbe(probeText({ vram_free_mb: "11874", card_busy: "yes" }))!)).toContain("arbiter");
    expect(parseProbe(probeText({ card_busy: "none" }))!.cardBusy).toBeNull();
  });

  test("a card whose free memory cannot be read is taken by any process on it", () => {
    expect(nodeBusy(parseProbe(probeText({ gpu_procs: "1", vram_free_mb: "none" }))!)).toBe(true);
    expect(nodeBusy(parseProbe(probeText({ gpu_procs: "0", vram_free_mb: "none" }))!)).toBe(false);
  });

  test("a node with nothing on it needs every file", () => {
    expect(outdatedFiles(digests, null)).toEqual([...NODE_FILES].sort());
  });

  test("the probe hashes every file a node is given, so a file put across reads as current", () => {
    const folder = scratchDir("bmo-laya-probe-");
    for (const name of NODE_FILES) {
      writeFileSync(join(folder, name), `${name}\n`);
    }
    writeFileSync(join(folder, "node-probe.sh"), readFileSync(nodeFileSource(REPOSITORY_ROOT, "node-probe.sh")));

    const probed = Bun.spawnSync(["bash", join(folder, "node-probe.sh")], { stdin: "ignore" });
    const probe = parseProbe(probed.stdout.toString());

    expect(Object.keys(probe?.digests ?? {}).sort()).toEqual([...NODE_FILES].sort());
    expect(Object.values(probe?.digests ?? {})).not.toContain("none");
  });

  test("the pin is read from the project file rather than kept beside it", () => {
    expect(pinnedLaya('[project]\ndependencies = [\n  "laya==0.3.5",\n  "torch>=2.14",\n]')).toBe("0.3.5");
    expect(pinnedLaya('[project]\ndependencies = ["torch>=2.14"]')).toBeNull();
    expect(pinnedLaya(readFileSync(nodeFileSource(REPOSITORY_ROOT, "pyproject.toml"), "utf8"))).toBe("0.3.5");
  });
});

describe("what a setup log says about itself", () => {
  test("still running", () => {
    expect(parseSetupEnd("[10:02:11] installing what pyproject pins\n")).toEqual({ done: false, ok: false, fault: null });
  });

  test("finished", () => {
    expect(parseSetupEnd("[10:04:02] what stands now\nLAYA-SETUP-DONE ok\n")).toEqual({ done: true, ok: true, fault: null });
  });

  test("broke, and where", () => {
    expect(parseSetupEnd("LAYA-SETUP-DONE failed:install\n")).toEqual({ done: true, ok: false, fault: "install" });
  });
});

describe("standing a node up", () => {
  test("a clean node is given the probe, then the files, then the environment", async () => {
    const short = probeText({ venv_python: "none", "pkg.laya": "none", "pkg.torch": "none", "pkg.transformers": "none",
      "pkg.safetensors": "none", uv: "none", ...Object.fromEntries(NODE_FILES.map((name) => [`sha.${name}`, "none"])) });
    const { runner, seen } = fakeRunner({
      probe: (calls) => calls === 1 ? answer("bash: node-probe.sh: No such file", 127) : calls === 2 ? answer(short) : answer(probeText()),
    });

    const outcome = await standNode("bravo", standing(runner));

    expect(outcome.setup).toBe("installed");
    expect(outcome.ready).toBe(true);
    expect(outcome.missing).toEqual([]);
    expect(outcome.uploaded).toEqual([...NODE_FILES].sort());
    expect(uploads(seen)).toContain(`${REPOSITORY}/runtime/laya-server/node-setup.sh`);
    expect(launched(seen)).toBe(true);
  });

  test("a node already right is read and left alone", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer(probeText()) });

    const outcome = await standNode("alpha", standing(runner));

    expect(outcome.setup).toBe("already right");
    expect(outcome.ready).toBe(true);
    expect(uploads(seen)).toEqual([]);
    expect(launched(seen)).toBe(false);
  });

  test("a busy card is not touched", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer(probeText({ gpu_procs: "2", vram_free_mb: "4210", "pkg.torch": "none" })) });

    const outcome = await standNode("delta", standing(runner));

    expect(outcome.setup).toBe("busy");
    expect(outcome.ready).toBe(false);
    expect(outcome.fault).toContain("4210MB");
    expect(uploads(seen)).toEqual([]);
    expect(launched(seen)).toBe(false);
  });

  test("a busy card on a node short of nothing else leaves the node ready, its gates waiting for the card", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer(probeText({ gpu_procs: "2", vram_free_mb: "2734" })) });

    const outcome = await standNode("delta", standing(runner));

    expect(outcome.setup).toBe("already right");
    expect(outcome.ready).toBe(true);
    expect(uploads(seen)).toEqual([]);
    expect(launched(seen)).toBe(false);
  });

  test("a node that never answers is said to be out of reach", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer("", 255), upload: () => answer("", 1) });

    const outcome = await standNode("charlie", standing(runner));

    expect(outcome.setup).toBe("unreachable");
    expect(outcome.probe).toBeNull();
    expect(launched(seen)).toBe(false);
  });

  test("a setup that broke names the step and where its log is", async () => {
    const { runner } = fakeRunner({
      probe: () => answer(probeText({ "pkg.torch": "none" })),
      tail: () => answer("[10:03] installing what pyproject pins\nLAYA-SETUP-DONE failed:install\n"),
    });

    const outcome = await standNode("charlie", standing(runner));

    expect(outcome.setup).toBe("failed");
    expect(outcome.fault).toContain("install");
    expect(outcome.fault).toContain("setup.log");
  });

  test("a setup that never finishes is not waited on for ever", async () => {
    const { runner } = fakeRunner({
      probe: () => answer(probeText({ "pkg.torch": "none" })),
      tail: () => answer("[10:03] installing what pyproject pins\n"),
    });

    const outcome = await standNode("charlie", standing(runner));

    expect(outcome.setup).toBe("failed");
    expect(outcome.fault).toContain("setup.log");
  });

  test("a setup that finished and left the node short is not called ready", async () => {
    const { runner } = fakeRunner({ probe: () => answer(probeText({ "pkg.torch": "none" })) });

    const outcome = await standNode("charlie", standing(runner));

    expect(outcome.setup).toBe("failed");
    expect(outcome.ready).toBe(false);
    expect(outcome.missing.join(" ")).toContain("torch");
  });

  test("an install already in flight is waited on rather than started again", async () => {
    const { runner, seen } = fakeRunner({
      probe: (calls) => calls === 1
        ? answer(probeText({ "pkg.torch": "none", setup_running: "yes" }))
        : answer(probeText()),
    });

    const outcome = await standNode("charlie", standing(runner));

    expect(outcome.setup).toBe("installed");
    expect(outcome.ready).toBe(true);
    expect(uploads(seen)).toEqual([]);
    expect(launched(seen)).toBe(false);
  });

  test("--check reads a node and changes nothing", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer(probeText({ "pkg.torch": "none" })) });

    const outcome = await standNode("bravo", standing(runner, true));

    expect(outcome.setup).toBe("not asked");
    expect(outcome.ready).toBe(false);
    expect(uploads(seen)).toEqual([]);
    expect(launched(seen)).toBe(false);
  });

  test("a node out of reach does not take the others down with it", async () => {
    const runner: NodeRunner = async (argv) => {
      const node = argv[4];
      const command = argv[5] ?? "";
      if (node === "delta") {
        return answer("", 255);
      }
      if (command.startsWith("echo HOME")) {
        return answer("HOME=/srv/trainer\n");
      }

      return command.includes("node-probe.sh") ? answer(probeText({ host: `${node}.example.test` })) : answer("");
    };

    const outcomes = await standNodes(["alpha", "delta", "bravo"], standing(runner));

    expect(outcomes.map((one) => one.node)).toEqual(["alpha", "delta", "bravo"]);
    expect(outcomes.map((one) => one.ready)).toEqual([true, false, true]);
    expect(outcomes[1]!.setup).toBe("unreachable");
  });

  test("a node that is not a training node is refused before anything reaches it", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer(probeText({})) });

    expect(notTrainingNodes(["alpha", "delta"], TRAINING)).toBeNull();
    expect(notTrainingNodes(["alpha", "echo"], TRAINING)).toContain("echo: not a training node");
    await expect(standNode("echo", standing(runner))).rejects.toThrow("not a training node");
    await expect(standNodes(["alpha", "echo"], standing(runner))).rejects.toThrow("echo");
    expect(seen).toEqual([]);
  });

  test("a placement naming no training node refuses every node, and says so whole", () => {
    const refused = notTrainingNodes(["alpha"], []);
    expect(refused).toContain("names no training node");
    expect(notTrainingNodes([], [])).toBe(refused);
  });

  test("a node whose login takes no bash drops out of training rather than failing the run", async () => {
    const rows: Record<string, string> = {
      "office-pc": '{"kind":"ssh","host":"203.0.113.82","port":2222,"user":"tester","keyPath":null,"shell":"powershell","role":null}',
      alpha: '{"kind":"ssh","host":"alpha","port":22,"user":"tester","keyPath":null,"role":null}',
    };
    const runner: NodeRunner = async (argv) => ({ code: 0, stdout: `${rows[argv.at(-1)!]}\n`, stderr: "" });

    const found = await reachTrainingNodes(["office-pc", "alpha"], runner, "", ["bmo-node"]);
    if (typeof found === "string") {
      throw new Error(found);
    }
    expect([...found.reached.keys()]).toEqual(["alpha"]);
    expect(found.dropped).toEqual(["office-pc logs into Windows PowerShell, so it takes no bash command — it drops out of training"]);
    expect(await nothingToTrainOn(["office-pc", "alpha"], runner, "", ["bmo-node"])).toBeNull();

    const nowhere = await nothingToTrainOn(["office-pc"], runner, "", ["bmo-node"]);
    expect(nowhere).toContain("there is no node to train Laya on now");
    expect(nowhere).toContain("office-pc logs into Windows PowerShell");
    expect(await nothingToTrainOn([], runner, "", ["bmo-node"])).toContain("names no training node");
  });

  test("a node reserved for other services takes the training only where its role names the training or the Laya service", async () => {
    const rows: Record<string, string> = {
      beneath: '{"kind":"ssh","host":"beneath","port":22,"user":"tester","keyPath":null,"role":"song+voice+laya-train"}',
      service: '{"kind":"ssh","host":"service","port":22,"user":"tester","keyPath":null,"role":"laya"}',
      voice: '{"kind":"ssh","host":"voice","port":22,"user":"tester","keyPath":null,"role":"song+voice"}',
    };
    const runner: NodeRunner = async (argv) => ({ code: 0, stdout: `${rows[argv.at(-1)!]}\n`, stderr: "" });

    const found = await reachTrainingNodes(["beneath", "service"], runner, "", ["bmo-node"]);
    if (typeof found === "string") {
      throw new Error(found);
    }
    expect([...found.reached.keys()]).toEqual(["beneath", "service"]);
    expect(await reachTrainingNodes(["voice"], runner, "", ["bmo-node"])).toContain("song+voice");
  });

  test("the training nodes are the placement's list, which may be empty but may not name a node twice", () => {
    const placed = (value: unknown) => {
      const root = scratchDir("bmo-training-placement-");
      mkdirSync(join(root, "placements"));
      writeFileSync(placementPath(TRAINING_PLACEMENT.file, root), JSON.stringify(value));
      return () => readPlacement(TRAINING_PLACEMENT, root);
    };

    expect(placed({ nodes: TRAINING })()).toEqual(TRAINING);
    expect(placed({ nodes: [] })()).toEqual([]);
    expect(placed({ nodes: ["alpha", "alpha"] })).toThrow("holds alpha twice");
  });
});

describe("the five side by side", () => {
  test("a column a node, and what is short said underneath", () => {
    const outcomes: NodeOutcome[] = [
      { node: "alpha", probe: parseProbe(probeText({ host: "node2.example.test" })), uploaded: [], setup: "already right",
        ready: true, missing: [], fault: null, seconds: 2.1 },
      { node: "bravo", probe: parseProbe(probeText({ gpu_procs: "1", vram_free_mb: "5480" })), uploaded: [], setup: "busy", ready: false,
        missing: ["the card carries 1 process"], fault: "the card carries 1 process — left as it stands", seconds: 1.4 },
    ];

    const table = nodeTable(outcomes);

    expect(table).toContain("alpha");
    expect(table).toContain("bravo");
    expect(table).toContain("node2.example.test");
    expect(table).toContain("already right");
    expect(table).toContain("card in use, left alone");
    expect(table.split("\n").at(-1)).toContain("bravo:");
  });

  test("a Hangul letter is two columns, so the columns line up", () => {
    expect(printedWidth("\uc900\ube44\ub428")).toBe(6);
    expect(printedWidth("uv")).toBe(2);
    expect(printedWidth("\ub0a8\uc740 \ub514\uc2a4\ud06c")).toBe(11);

    const outcomes: NodeOutcome[] = ["alpha", "bravo"].map((node) => ({
      node, probe: parseProbe(probeText()), uploaded: [], setup: "already right" as const, ready: true,
      missing: [], fault: null, seconds: 1,
    }));
    const lines = nodeTable(outcomes).split("\n").filter((one) => one.includes("  "));
    // The last column begins at the same printed offset on every line, which is what an eye reads as
    // the columns lining up.
    const starts = new Set(lines.map((one) => printedWidth(one.slice(0, one.lastIndexOf("  ")))));

    expect(starts.size).toBe(1);
  });

  test("the files a node was given are named underneath rather than widening a column", () => {
    const outcomes: NodeOutcome[] = [{
      node: "delta", probe: parseProbe(probeText()), uploaded: ["finetune.py", "resume.py"], setup: "installed",
      ready: true, missing: [], fault: null, seconds: 61.2,
    }];

    const table = nodeTable(outcomes);

    expect(table.split("\n").find((one) => one.startsWith("files put across"))).toContain("2");
    expect(table).toContain("delta: put across finetune.py, resume.py");
  });
});
