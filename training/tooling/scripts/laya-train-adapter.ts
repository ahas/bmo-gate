import { runAdapter } from "../src/card-adapter";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import { layaTrainAdapter } from "../src/laya-train-adapter";

// Laya training's adapter, which the card master runs for every placement of `laya-train`
// (docs/training.md, 「The nodes」; the arbiter's docs/placement.md, 「An adapter's verbs」).
//
// usage: bun scripts/laya-train-adapter.ts install|uninstall|start|stop|health --node <node> --placed <node,…>
//        bun scripts/laya-train-adapter.ts placed

process.exit(await runAdapter(process.argv.slice(2), (ask) =>
  layaTrainAdapter(ask, { runner: spawnRunner, console: nodeConsole(), say: (line) => console.log(line) })));
