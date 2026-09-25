import { readFileSync } from "node:fs";
import { join } from "node:path";

import { claimGate, releaseGate } from "../src/gate-claim";
import { allOf, asked, asksUsage, lastOf, readFlags } from "../src/flags";
import { jakeConsole, spawnRunner } from "../src/jake";
import { collectCheckpoint, collectionRoot, readManifest } from "../src/laya-collect";
import { localDigests, notTrainingNodes, pinnedLaya, readCard, standNodes, TRAINING_NODES } from "../src/laya-nodes";
import { carryCheckpoint } from "../src/laya-serve";
import { layaHealth, servingCheckpoint } from "../src/laya-service";
import { dataPath, sourceRoot } from "../src/roots";
import { curveLines, readCurve } from "../src/train/curve";
import { BESIDE_DIR, runGate } from "../src/train/gate-run";
import { runPass } from "../src/train/pass";
import { sourceOf } from "../src/train/sources";

// One training pass over a source (docs/training.md): which gates are trained and why the rest wait,
// each chosen gate on a node of its own, calibrated beside the checkpoint serving it, its checkpoint
// carried back, and the ledger, the curve and the tables written.

const usage = `usage: bun scripts/laya-train.ts <원천> [--gate <게이트>]… [--node <노드>]… [--rarer <개>] [--epochs <n>] [--seed <n>] [--save-every <n>] [--dry-run] [--show]

원천의 게이트 가운데 학습할 만큼 자란 것을 노드마다 하나씩 맡겨 학습시키고, 끝난 체크포인트를 지금
서비스 중인 체크포인트 옆에서 같은 시험 행으로 재고, 원장·곡선·표를 남긴다(docs/training.md).
<원천> 은 reference:<실행>(참조 데이터), judging:<실행>(판정 회차), folder:<경로>(데이터 폴더, 리허설 포함).
--gate 는 이 게이트들만 본다. --node 없이는 ${TRAINING_NODES.join(", ")} 를 쓴다.
--rarer 는 판정 회차의 게이트를 드문 답 몇 개까지 기다리게 할지(참조 데이터는 스스로 200개를 요구한다).
--dry-run 은 어느 게이트를 왜 학습하고 나머지는 왜 기다리는지만 말하고 아무것도 건드리지 않는다.
--show 는 원천의 곡선을 보인다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--gate": true, "--node": true, "--rarer": true, "--epochs": true, "--seed": true, "--save-every": true, "--dry-run": false, "--show": false,
});

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-train: ${reading.trouble ?? "원천을 하나 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const source = sourceOf(reading.loose[0]!, { rarer: Number(lastOf(reading, "--rarer") ?? "0") });

if (typeof source === "string") {
  console.error(`laya-train: ${source}`);
  process.exit(2);
}

const curve = dataPath("laya-curve", source.name);
const say = (line: string) => console.error(line);

if (asked(reading, "--show")) {
  const points = readCurve(curve);

  console.log(points.length === 0 ? `${curve} 에 아직 곡선이 없어요.` : curveLines(points).join("\n"));
  process.exit(0);
}

const nodes = allOf(reading, "--node").length > 0 ? allOf(reading, "--node") : [...TRAINING_NODES];
const refused = notTrainingNodes(nodes);

if (refused !== null) {
  console.error(`laya-train: ${refused}`);
  process.exit(2);
}

const dryRun = asked(reading, "--dry-run");

// One pass at a time per source: a pass started by hand beside the timer's would put two gates on one
// card. A pass already going is doing this pass's work, so standing down is not a failure.
const refusal = dryRun ? null : claimGate(curve);

if (refusal !== null) {
  console.log(`다른 회차가 돌고 있어서 이번에는 쉬어요.\n${refusal}`);
  process.exit(0);
}

const server = join(sourceRoot(), "laya-server");
const args: string[] = [];

for (const flag of ["--epochs", "--seed", "--save-every"]) {
  const given = lastOf(reading, flag);

  if (given !== undefined) {
    args.push(flag, given);
  }
}

const health = dryRun ? null : await layaHealth();
const report = await runPass({
  source,
  curve,
  passFolder: (pass) => dataPath("laya-runs", pass),
  gates: allOf(reading, "--gate").length > 0 ? allOf(reading, "--gate") : null,
  dryRun,
  hands: {
    // A node is stood up before it is given a gate, and a node whose card is busy is left out.
    nodes: async () => {
      const outcomes = await standNodes(nodes, {
        runner: spawnRunner,
        console: jakeConsole(),
        folder: server,
        digests: localDigests(server),
        pinned: pinnedLaya(readFileSync(join(server, "pyproject.toml"), "utf8")),
        say,
      });

      for (const one of outcomes.filter((outcome) => !outcome.ready)) {
        say(`${one.node}: 이번 회차에서 뺐어요 — ${one.fault ?? one.setup}`);
      }

      return outcomes.filter((one) => one.ready).map((one) => one.node);
    },
    card: (node) => readCard(node, spawnRunner, jakeConsole()),
    // The checkpoint serving the gate today, where the collection holds it.
    beside: async (gate) => {
      const served = servingCheckpoint(health, gate)?.replace(/^checkpoints\//, "") ?? null;

      return served !== null && readManifest(join(collectionRoot(), served)) !== null ? served : null;
    },
    runGate: (gate, node, round, run) => runGate(gate, node, round, {
      runner: spawnRunner,
      console: jakeConsole(),
      pass: run.pass,
      rehearsal: source.rehearsal,
      folder: run.folder,
      beside: run.beside,
      args,
      carryBeside: async (at, checkpoint) => {
        const carried = await carryCheckpoint({ runner: spawnRunner, console: jakeConsole(), node: at, checkpoint, dir: BESIDE_DIR, say });

        return typeof carried === "string" ? carried : null;
      },
      collect: async (ask) => {
        const carried = await collectCheckpoint({
          runner: spawnRunner, console: jakeConsole(), node: ask.node, gate: ask.gate, run: run.pass, step: ask.step,
          checkpoint: ask.kind, source: ask.source, dataset: run.pass, rehearsal: source.rehearsal, root: collectionRoot(), say,
        });

        return typeof carried === "string" ? carried : { folder: carried.folder };
      },
      say,
    }),
  },
  say,
}).finally(() => {
  if (!dryRun) {
    releaseGate(curve);
  }
});

if (report.fault !== null) {
  console.error(`laya-train: ${report.fault}`);
  process.exit(1);
}

if (dryRun || report.ledger === null) {
  console.log(report.train.length === 0
    ? "이번 회차에 학습시킬 게이트가 없어요."
    : `이번 회차에 학습시킬 게이트: ${report.train.join(", ")}`);
  process.exit(0);
}

console.log(`${dataPath("laya-runs", report.training!)}/tables.md 에 표를 썼어요.`);
console.log(curveLines(readCurve(curve)).join("\n"));
process.exit(report.ledger.rows.every((row) => row.state === "done") ? 0 : 1);
