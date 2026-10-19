import { runAdapter } from "../src/card-adapter";
import { nodeConsole, spawnRunner } from "../src/node-calls";
import { layaAdapter } from "../src/laya-adapter";

// The Laya service's adapter, which the card master runs for every placement of `laya`
// (docs/llm-server.md, 「Moving the service」; the arbiter's docs/placement.md, 「An adapter's verbs」).
//
// usage: bun scripts/laya-adapter.ts install|uninstall|start|stop|health --node <node> --placed <node,…>
//        bun scripts/laya-adapter.ts placed

process.exit(await runAdapter(process.argv.slice(2), (ask) =>
  layaAdapter(ask, { runner: spawnRunner, console: nodeConsole(), say: (line) => console.log(line) })));
