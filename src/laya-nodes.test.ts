import { describe, expect, test } from "bun:test";

import {
  NODE_FILES,
  jakeExecArgs,
  jakeUploadArgs,
  nodeBusy,
  nodeFilePath,
  nodePath,
  parseHome,
  nodeTable,
  outdatedFiles,
  parseProbe,
  parseSetupEnd,
  pinnedLaya,
  printedWidth,
  readiness,
  setupLaunchCommand,
  standNode,
  standNodes,
  type NodeOutcome,
  type NodeRunner,
  type RunResult,
} from "./laya-nodes";

const CONSOLE = "/home/ahas/repos/ahas/infra/jake/src/console/main.ts";
const FOLDER = "/checkout/laya-server";

// What this checkout's files come to, as the probe would report them back.
const digests: Record<string, string> = Object.fromEntries(NODE_FILES.map((name, index) => [name, `sha-${index}`]));

function probeText(changes: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    host: "node3.labuser.local",
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

/** A stand-in for the jake console: it is told what each kind of call answers, and it keeps every call
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
      return answer("HOME=/home/labuser\n");
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

const standing = (runner: NodeRunner, check = false) => ({
  runner,
  console: CONSOLE,
  folder: FOLDER,
  digests,
  pinned: "0.3.5",
  check,
  wait: async () => {},
  polls: 4,
  everyMs: 1,
});

const uploads = (seen: Seen[]) => seen.filter((one) => one.argv[2] === "upload").map((one) => one.argv[3]);
const launched = (seen: Seen[]) => seen.some((one) => (one.argv[5] ?? "").includes("node-setup.sh > setup.log"));

describe("the calls a node is reached with", () => {
  test("exec names the agent and carries the command whole", () => {
    expect(jakeExecArgs(CONSOLE, "n3", "bash ~/bmo-laya/node-probe.sh"))
      .toEqual(["bun", CONSOLE, "exec", "-a", "n3", "bash ~/bmo-laya/node-probe.sh"]);
  });

  test("upload names the local file, the remote path and the agent", () => {
    expect(jakeUploadArgs(CONSOLE, "n4", `${FOLDER}/resume.py`, nodeFilePath("/home/labuser", "resume.py")))
      .toEqual(["bun", CONSOLE, "upload", `${FOLDER}/resume.py`, "/home/labuser/bmo-laya/resume.py", "-a", "n4"]);
  });

  test("an upload's path is written out whole, since no shell reads it", () => {
    expect(nodeFilePath("/home/labuser", "finetune.py")).toBe("/home/labuser/bmo-laya/finetune.py");
    expect(nodeFilePath("/home/labuser/", "finetune.py")).toBe("/home/labuser/bmo-laya/finetune.py");
    expect(nodeFilePath("/home/labuser", "finetune.py")).not.toContain("~");
    expect(nodePath("finetune.py")).toBe("~/bmo-laya/finetune.py");
  });

  test("the home a node says is read, and a node that says none is not guessed at", () => {
    expect(parseHome("HOME=/home/labuser\n")).toBe("/home/labuser");
    expect(parseHome("some warning\nHOME=/home/labuser")).toBe("/home/labuser");
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

    expect(probe.host).toBe("node3.labuser.local");
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

    expect(probe.host).toBe("node3.labuser.local");
  });

  test("an answer with no host in it is not a reading", () => {
    expect(parseProbe("bash: /home/labuser/bmo-laya/node-probe.sh: No such file or directory")).toBeNull();
    expect(parseProbe("")).toBeNull();
  });
});

describe("whether a node can take a gate", () => {
  test("a node with everything is ready", () => {
    expect(readiness(parseProbe(probeText()), "0.3.5", digests)).toEqual({ ready: true, missing: [] });
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

  test("a card with a process on it is busy", () => {
    expect(nodeBusy(parseProbe(probeText({ gpu_procs: "1" }))!)).toBe(true);
    expect(nodeBusy(parseProbe(probeText())!)).toBe(false);
  });

  test("a node with nothing on it needs every file", () => {
    expect(outdatedFiles(digests, null)).toEqual([...NODE_FILES].sort());
  });

  test("the pin is read from the project file rather than kept beside it", () => {
    expect(pinnedLaya('dependencies = [\n  "laya==0.3.5",\n  "torch>=2.14",\n]')).toBe("0.3.5");
    expect(pinnedLaya('dependencies = ["torch>=2.14"]')).toBeNull();
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

    const outcome = await standNode("n3", standing(runner));

    expect(outcome.setup).toBe("installed");
    expect(outcome.ready).toBe(true);
    expect(outcome.missing).toEqual([]);
    expect(outcome.uploaded).toEqual([...NODE_FILES].sort());
    expect(uploads(seen)).toContain(`${FOLDER}/node-setup.sh`);
    expect(launched(seen)).toBe(true);
  });

  test("a node already right is read and left alone", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer(probeText()) });

    const outcome = await standNode("n2", standing(runner));

    expect(outcome.setup).toBe("already right");
    expect(outcome.ready).toBe(true);
    expect(uploads(seen)).toEqual([]);
    expect(launched(seen)).toBe(false);
  });

  test("a busy card is not touched", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer(probeText({ gpu_procs: "2", "pkg.torch": "none" })) });

    const outcome = await standNode("n5", standing(runner));

    expect(outcome.setup).toBe("busy");
    expect(outcome.ready).toBe(false);
    expect(outcome.fault).toContain("2");
    expect(uploads(seen)).toEqual([]);
    expect(launched(seen)).toBe(false);
  });

  test("a node that never answers is said to be out of reach", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer("", 255), upload: () => answer("", 1) });

    const outcome = await standNode("n4", standing(runner));

    expect(outcome.setup).toBe("unreachable");
    expect(outcome.probe).toBeNull();
    expect(launched(seen)).toBe(false);
  });

  test("a setup that broke names the step and where its log is", async () => {
    const { runner } = fakeRunner({
      probe: () => answer(probeText({ "pkg.torch": "none" })),
      tail: () => answer("[10:03] installing what pyproject pins\nLAYA-SETUP-DONE failed:install\n"),
    });

    const outcome = await standNode("n6", standing(runner));

    expect(outcome.setup).toBe("failed");
    expect(outcome.fault).toContain("install");
    expect(outcome.fault).toContain("setup.log");
  });

  test("a setup that never finishes is not waited on for ever", async () => {
    const { runner } = fakeRunner({
      probe: () => answer(probeText({ "pkg.torch": "none" })),
      tail: () => answer("[10:03] installing what pyproject pins\n"),
    });

    const outcome = await standNode("n6", standing(runner));

    expect(outcome.setup).toBe("failed");
    expect(outcome.fault).toContain("setup.log");
  });

  test("a setup that finished and left the node short is not called ready", async () => {
    const { runner } = fakeRunner({ probe: () => answer(probeText({ "pkg.torch": "none" })) });

    const outcome = await standNode("n6", standing(runner));

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

    const outcome = await standNode("n4", standing(runner));

    expect(outcome.setup).toBe("installed");
    expect(outcome.ready).toBe(true);
    expect(uploads(seen)).toEqual([]);
    expect(launched(seen)).toBe(false);
  });

  test("--check reads a node and changes nothing", async () => {
    const { runner, seen } = fakeRunner({ probe: () => answer(probeText({ "pkg.torch": "none" })) });

    const outcome = await standNode("n3", standing(runner, true));

    expect(outcome.setup).toBe("not asked");
    expect(outcome.ready).toBe(false);
    expect(uploads(seen)).toEqual([]);
    expect(launched(seen)).toBe(false);
  });

  test("a node out of reach does not take the others down with it", async () => {
    const runner: NodeRunner = async (argv) => {
      const node = argv[4];
      const command = argv[5] ?? "";
      if (node === "n5") {
        return answer("", 255);
      }
      if (command.startsWith("echo HOME")) {
        return answer("HOME=/home/labuser\n");
      }

      return command.includes("node-probe.sh") ? answer(probeText({ host: `${node}.labuser.local` })) : answer("");
    };

    const outcomes = await standNodes(["n2", "n5", "n6"], standing(runner));

    expect(outcomes.map((one) => one.node)).toEqual(["n2", "n5", "n6"]);
    expect(outcomes.map((one) => one.ready)).toEqual([true, false, true]);
    expect(outcomes[1]!.setup).toBe("unreachable");
  });
});

describe("the five side by side", () => {
  test("a column a node, and what is short said underneath", () => {
    const outcomes: NodeOutcome[] = [
      { node: "n2", probe: parseProbe(probeText({ host: "node2.labuser.local" })), uploaded: [], setup: "already right",
        ready: true, missing: [], fault: null, seconds: 2.1 },
      { node: "n3", probe: parseProbe(probeText({ gpu_procs: "1" })), uploaded: [], setup: "busy", ready: false,
        missing: ["카드에 프로세스가 1개 올라가 있어요"], fault: "카드에 이미 프로세스가 1개 있어 그대로 두었어요", seconds: 1.4 },
    ];

    const table = nodeTable(outcomes);

    expect(table).toContain("n2");
    expect(table).toContain("n3");
    expect(table).toContain("node2.labuser.local");
    expect(table).toContain("그대로 좋음");
    expect(table).toContain("쓰는 중이라 건드리지 않음");
    expect(table.split("\n").at(-1)).toContain("n3:");
  });

  test("a Korean label is two columns a letter, so the columns line up", () => {
    expect(printedWidth("준비됨")).toBe(6);
    expect(printedWidth("uv")).toBe(2);
    expect(printedWidth("남은 디스크")).toBe(11);

    const outcomes: NodeOutcome[] = ["n2", "n3"].map((node) => ({
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
      node: "n5", probe: parseProbe(probeText()), uploaded: ["finetune.py", "resume.py"], setup: "installed",
      ready: true, missing: [], fault: null, seconds: 61.2,
    }];

    const table = nodeTable(outcomes);

    expect(table).toContain("2개");
    expect(table).toContain("n5: 올린 파일 finetune.py, resume.py");
  });
});
