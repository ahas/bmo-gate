import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { claimGate, releaseGate } from "../src/gate-claim";
import { growingCounts } from "../src/gate-merge";
import { allOf, asksUsage, lastOf, readFlags } from "../src/flags";
import { choosePass, curveFloor, curveGrowth, curveLines, readCurve, runPass } from "../src/laya-curve";
import { jakeConsole, spawnRunner } from "../src/jake";
import { localDigests, notTrainingNodes, pinnedLaya, standNodes, TRAINING_NODES } from "../src/laya-nodes";
import { trainOnNodes } from "../src/laya-train";
import { dataPath, runFolder, sourceRoot } from "../src/roots";

// Training while the judging still runs (docs/laya-train-run.md 「Training while the judging runs」):
// one pass cuts every gate at the batches frozen so far, trains the ones that grew enough since
// their last point, and writes a point a gate into the curve. The timer `bmo-gate-curve` runs it,
// so the curve grows with the judging and nobody has to start it.

const usage = `usage: bun scripts/laya-curve.ts <실행> [--node <노드>]… [--floor <행>] [--growth <배수>] [--dry-run] [--show]

판정 중인 게이트를 지금까지 굳은 묶음까지로 잘라, 지난 회차보다 충분히 자란 게이트만 학습시키고
회차마다 게이트별 행 수·일치도·균형 정확도·보정 오차를 곡선 원장에 남긴다.
--node 없이는 ${TRAINING_NODES.join(", ")} 가운데 비어 있고 준비된 노드를 쓴다.
--floor 는 세우는 최소 행 수(기본 ${curveFloor}), --growth 는 다시 학습하기까지 늘어야 하는 배수(기본 ${curveGrowth}).
--dry-run 은 이번 회차에 무엇을 학습시킬지만 보이고 아무것도 건드리지 않는다.
--show 는 지금까지의 곡선만 보인다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--node": true, "--floor": true, "--growth": true, "--dry-run": false, "--show": false });

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`laya-curve: ${reading.trouble ?? "실행 하나를 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const root = runFolder(reading.loose[0]!);
const run = basename(root);
const curve = dataPath("laya-curve", run);
const floor = Number(lastOf(reading, "--floor") ?? curveFloor);
const growth = Number(lastOf(reading, "--growth") ?? curveGrowth);

if (!Number.isInteger(floor) || floor < 1 || !Number.isFinite(growth) || growth <= 1) {
  console.error("laya-curve: --floor 는 1 이상의 정수, --growth 는 1 보다 큰 수여야 해요.");
  process.exit(2);
}

if (argv.includes("--show")) {
  const points = readCurve(curve);

  console.log(points.length === 0 ? `${curve} 에 아직 곡선이 없어요.` : curveLines(points).join("\n"));
  process.exit(0);
}

const say = (line: string) => console.error(line);

if (argv.includes("--dry-run")) {
  const counts = growingCounts(root);

  if (typeof counts === "string") {
    console.error(`laya-curve: ${counts}`);
    process.exit(1);
  }

  const choice = choosePass(counts, readCurve(curve), { floor, growth });

  for (const one of choice.waiting) {
    say(`${one.gate}: ${one.rows}행 — ${one.reason}`);
  }
  console.log(choice.train.length === 0
    ? "이번 회차에 학습시킬 게이트가 없어요."
    : `이번 회차에 학습시킬 게이트: ${choice.train.map((one) => one.gate).join(", ")}`);
  process.exit(0);
}

const wanted = allOf(reading, "--node");
const nodes = wanted.length > 0 ? wanted : [...TRAINING_NODES];
const refused = notTrainingNodes(nodes);

if (refused !== null) {
  console.error(`laya-curve: ${refused}`);
  process.exit(2);
}

const server = join(sourceRoot(), "laya-server");

// One pass at a time: a pass started by hand beside the timer's would put two gates on one card. A
// pass already going is doing this pass's work, so standing down is not a failure.
const refusal = claimGate(curve);

if (refusal !== null) {
  console.log(`다른 회차가 돌고 있어서 이번에는 쉬어요.\n${refusal}`);
  process.exit(0);
}

const report = await runPass({
  root,
  run,
  curve,
  trainingRoot: (training) => dataPath("laya-runs", training),
  rule: { floor, growth },
  // A node is stood up before it is given a gate — the files that differ from this checkout go
  // across — and a node whose card is busy is left out of this pass rather than shared.
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
  train: (gates, ready, training, gateFolders) => trainOnNodes({
    gates, nodes: ready, run: training, runRoot: dataPath("laya-runs", training), gateFolders,
    rehearsal: false, runner: spawnRunner, say,
  }),
  say,
}).finally(() => releaseGate(curve));

if (report.fault !== null) {
  console.error(`laya-curve: ${report.fault}`);
  process.exit(1);
}

if (report.pass === null) {
  console.log("이번 회차에 학습시킬 게이트가 없어요.");
  process.exit(0);
}

console.log(curveLines(readCurve(curve)).join("\n"));
process.exit(report.points.every((point) => point.state === "done") ? 0 : 1);
