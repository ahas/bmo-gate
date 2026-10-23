// The gates' screens as a layer on bmo-ui: the gate order and a gate's trial page, the same pages the gate serves as
// its console bundle's module. A host extends it as it extends bmo-ui, and brings what the console plugin contract
// asks of a console (`docs/layout.md`, 「The console plugin bundle」).
export default defineNuxtConfig({
  extends: ["bmo-ui"],
  compatibilityDate: "2025-09-01",
  devtools: { enabled: false }
});
