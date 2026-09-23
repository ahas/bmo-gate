import { asksUsage, lastOf, readFlags } from "../src/flags";
import {
  collectCheckpoint,
  collectLines,
  collectedCheckpoints,
  collectionRoot,
  type CheckpointKind,
} from "../src/laya-collect";
import { jakeConsole, type NodeRunner, type RunResult } from "../src/laya-nodes";
import { checkpointOnNode, readTrainLedger } from "../src/laya-train";
import { dataPath } from "../src/roots";

// A checkpoint carried off the node that made it (docs/laya-train-run.md, 「Checkpoint naming and
// collection」). Node-local is not enough: a node that dies must not be the only copy of a step.
//
// usage: bun scripts/laya-collect.ts --node <노드> --gate <게이트> --run <이름> --step <n> [--kind final|step] [--overwrite]
//        bun scripts/laya-collect.ts --list

const usage = `usage: bun scripts/laya-collect.ts --node <노드> --gate <게이트> --run <이름> --step <n> [--kind final|step] [--source <노드 안 경로>] [--overwrite]
       bun scripts/laya-collect.ts --list

노드에서 만든 체크포인트를 작업대의 모음 자리로 가져온다. 게이트와 스텝이 이름에서 읽히게 두고,
어디서 왔는지와 리허설인지를 곁의 명세에 적는다.
이미 같은 게이트의 같은 스텝이 있으면 덮어쓰지 않고 거절한다 — 정말 바꾸려면 --overwrite 를 준다.
--kind 는 끝난 체크포인트(final)인지 중간 스텝(step)인지다. 기본은 final.
--source 없이는 --run 과 --gate 로 노드 위 자리를 짐작한다.
--list 는 지금까지 가져온 것을 보인다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--node": true, "--gate": true, "--run": true, "--step": true, "--kind": true, "--source": true, "--dataset": true,
  "--overwrite": false, "--list": false, "--json": false,
});

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-collect: ${reading.trouble ?? `옵션이 아닌 인자가 있어요 — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const value = (flag: string) => lastOf(reading, flag) ?? null;
const root = collectionRoot();

if (argv.includes("--list")) {
  const standing = collectedCheckpoints(root);

  console.log(argv.includes("--json") ? JSON.stringify(standing, null, 2) : collectLines(standing).join("\n"));
  process.exit(0);
}

const node = value("--node");
const gate = value("--gate");
const run = value("--run");
const step = Number(value("--step"));

if (node === null || gate === null || run === null || !Number.isInteger(step) || step < 0) {
  console.error("laya-collect: --node, --gate, --run, --step 을 모두 주세요.");
  console.error(usage);
  process.exit(2);
}

const kind = (value("--kind") ?? "final") as CheckpointKind;

if (kind !== "final" && kind !== "step") {
  console.error("laya-collect: --kind 는 final 또는 step 이에요.");
  process.exit(2);
}

// The ledger of the run says whether it was a rehearsal; without one the caller says so itself.
const ledger = readTrainLedger(dataPath("laya-runs", run));
const row = ledger?.rows.find((one) => one.gate === gate);
const source = value("--source")
  ?? (kind === "final" ? checkpointOnNode(run, gate) : `${checkpointOnNode(run, gate)}/steps/step-${String(step).padStart(6, "0")}`);

const runner: NodeRunner = async (args): Promise<RunResult> => {
  const going = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(going.stdout).text(), new Response(going.stderr).text()]);

  return { code: await going.exited, stdout, stderr };
};

const collected = await collectCheckpoint({
  runner,
  console: jakeConsole(),
  node,
  gate,
  run,
  step,
  checkpoint: kind,
  source,
  dataset: value("--dataset") ?? row?.dataset ?? run,
  rehearsal: row?.rehearsal ?? ledger?.rehearsal ?? false,
  overwrite: argv.includes("--overwrite"),
  root,
  say: (line) => console.error(line),
});

if (typeof collected === "string") {
  console.error(`laya-collect: ${collected}`);
  process.exit(1);
}

console.log(collectLines([collected.manifest]).join("\n"));
console.log(collected.folder);
