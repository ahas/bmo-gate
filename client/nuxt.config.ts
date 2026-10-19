// The gates' screen as a layer: its trial page, its domain modules and the server routes that call the gate, on
// top of bmo-ui. A host extends it as it extends bmo-ui, and brings its i18n module, its language pack, its sign-in
// and the components this layer leaves to it (`docs/layout.md`, 「The console plugin bundle」).
export default defineNuxtConfig({
  extends: ["bmo-ui"],
  // Where the gate answers and the token it is called with; the host sets them from NUXT_GATE_ADDRESS and
  // NUXT_GATE_TOKEN, and neither reaches the browser.
  runtimeConfig: {
    gate: { address: "", token: "" }
  },
  compatibilityDate: "2025-09-01",
  devtools: { enabled: false }
});
