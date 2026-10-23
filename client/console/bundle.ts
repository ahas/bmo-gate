import GateOrder from "../app/pages/gates/index.vue";
import GateTrials from "../app/pages/gates/[stage].vue";

import "./bundle.css";

import type { ConsoleBundleModule } from "bmo-ui/shared/console-manifest";

// The console bundle's module (bmo-ui's `docs/console-bundles.md`, "What a bundle is"): the routes of the gates'
// screens, each under the screen path `/gates` the gate's manifest names. The pages are the layer's own files.
const bundle: ConsoleBundleModule = {
  routes: [
    { path: "/gates", component: GateOrder },
    { path: "/gates/:stage", component: GateTrials }
  ]
};

export default bundle;
