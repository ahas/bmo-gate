import GateOrder from "../app/pages/gates/index.vue";
import GateTrials from "../app/pages/gates/[stage].vue";

import "./bundle.css";

import type { ConsoleBundleModule } from "bmo-ui/shared/console-manifest";

// The console bundle's module (bmo-ui's `docs/console-bundles.md`, "What a bundle is"): the routes of the gates'
// screens, each under the screen path `/gates` the gate's manifest names, each asking for the console's title bar.
// The pages are the layer's own files.
const bundle: ConsoleBundleModule = {
  routes: [
    { path: "/gates", component: GateOrder, meta: { consoleTitleBar: true } },
    { path: "/gates/:stage", component: GateTrials, meta: { consoleTitleBar: true } }
  ]
};

export default bundle;
