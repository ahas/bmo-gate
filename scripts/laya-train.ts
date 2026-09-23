import { basename, join } from "node:path";

import { allOf, asksUsage, lastOf, readFlags } from "../src/flags";
import { collectCheckpoint, collectionRoot } from "../src/laya-collect";
import { jakeConsole, TRAINING_NODES, type NodeRunner, type RunResult } from "../src/laya-nodes";
import { gateSyntheses } from "../src/laya-synth";
import {
  datasetIsRehearsal,
  driveRun,
  planRounds,
  trainLedgerLines,
  writeGateDataset,
  writeTrainLedger,
} from "../src/laya-train";
import { dataPath } from "../src/roots";

// The ten gates trained one to a node over two rounds (docs/laya-train-run.md, 「One gate to a node,
// two rounds」). It cuts the dataset into one folder a gate, puts each gate's folder on its node,
// starts the training detached, carries on what died from its own step checkpoint, calibrates what
// finished, and writes the ledger the verification table is assembled from.
//
// usage: bun scripts/laya-train.ts --data <폴더> [--gate <게이트>]… [--node <노드>]… [--run <이름>] [--epochs <n>] [--seed <n>] [--dry-run]

const usage = `usage: bun scripts/laya-train.ts --data <폴더> [--gate <게이트>]… [--node <노드>]… [--run <이름>] [--epochs <n>] [--seed <n>] [--save-every <n>] [--dry-run] [--json]

게이트마다 한 노드를 맡겨 학습시키고, 끝난 체크포인트마다 온도를 맞추고, 무엇이 얼마나 들었는지
원장에 적는다. 한 노드는 한 번에 한 게이트만 맡으니 열 게이트는 다섯 노드에서 두 차례가 된다.
학습은 노드에서 떼어 놓고 실행되기 때문에 허브가 끊어도 죽지 않고, 죽은 학습은 처음이 아니라 제
마지막 스텝 체크포인트에서 이어 간다.
--data 는 세 분할을 갖춘 데이터 폴더다. 게이트별로 잘라 노드에 올린다.
--gate 없이는 데이터에 든 열 게이트를 모두 학습시킨다.
--node 없이는 ${TRAINING_NODES.join(", ")} 다섯 대를 쓴다.
--run 은 원장과 노드 위 이름에 쓰일 이름이다(기본: 데이터 폴더 이름).
--dry-run 은 어느 노드가 어느 게이트를 맡는지만 보이고 아무것도 건드리지 않는다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--data": true, "--gate": true, "--node": true, "--run": true, "--epochs": true, "--seed": true, "--save-every": true,
  "--dry-run": false, "--json": false,
});

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-train: ${reading.trouble ?? `옵션이 아닌 인자가 있어요 — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const value = (flag: string) => lastOf(reading, flag) ?? null;
const many = (flag: string) => allOf(reading, flag);
const data = value("--data");

if (data === null) {
  console.error("laya-train: 데이터 폴더를 --data 로 주세요.");
  console.error(usage);
  process.exit(2);
}

const folder = data.startsWith("/") ? data : dataPath("laya-rehearsal", data);
const run = value("--run") ?? basename(folder);
const gates = many("--gate").length > 0 ? many("--gate") : gateSyntheses.map((one) => one.gate);
const nodes = many("--node").length > 0 ? many("--node") : [...TRAINING_NODES];
const rounds = planRounds(gates, nodes);

if (argv.includes("--dry-run")) {
  for (const [index, pairs] of rounds.entries()) {
    console.log(`${index + 1}번째 차례: ${pairs.map((one) => `${one.node} → ${one.gate}`).join(", ")}`);
  }
  process.exit(0);
}

// Each gate's own three splits, cut out here rather than on the node: the training trains on every
// gate in the folder it is given, so a gate is given a node by giving that node its rows alone.
const runRoot = dataPath("laya-runs", run);
const gateFolders: Record<string, string> = {};

for (const gate of gates) {
  const cut = writeGateDataset(folder, gate, join(runRoot, "gates", gate));

  if (typeof cut === "string") {
    console.error(`laya-train: ${cut}`);
    process.exit(1);
  }
  gateFolders[gate] = cut.folder;
  console.error(`${gate}: 학습 ${cut.rows.train}행 · 보정 ${cut.rows.calibration}행 · 시험 ${cut.rows.test}행`);
}

const runner: NodeRunner = async (args): Promise<RunResult> => {
  const going = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(going.stdout).text(), new Response(going.stderr).text()]);

  return { code: await going.exited, stdout, stderr };
};

const args: string[] = [];

for (const [flag, given] of [["--epochs", value("--epochs")], ["--seed", value("--seed")], ["--save-every", value("--save-every")]] as const) {
  if (given !== null) {
    args.push(flag, given);
  }
}

const rehearsal = datasetIsRehearsal(folder);
const ledger = await driveRun(gates, nodes, {
  runner,
  console: jakeConsole(),
  dataset: run,
  gateFolders,
  rehearsal,
  args,
  // A checkpoint is carried off the node as soon as it could become the only copy: when a run has
  // died and may not come back, and when a run has finished.
  collect: async (ask) => {
    const carried = await collectCheckpoint({
      runner,
      console: jakeConsole(),
      node: ask.node,
      gate: ask.gate,
      run,
      step: ask.step,
      checkpoint: ask.kind,
      source: ask.source,
      dataset: run,
      rehearsal,
      root: collectionRoot(),
      say: (line) => console.error(line),
    });

    return typeof carried === "string" ? carried : { folder: carried.folder };
  },
  say: (line) => console.error(line),
});

const written = writeTrainLedger(runRoot, ledger);

if (argv.includes("--json")) {
  console.log(JSON.stringify(ledger, null, 2));
} else {
  console.log(trainLedgerLines(ledger).join("\n"));
  console.log(`원장: ${written}`);
}

process.exit(ledger.rows.every((row) => row.state === "done") ? 0 : 1);
