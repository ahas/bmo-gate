import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

import type { Plugin } from "vite";

// The console bundle's build (`docs/layout.md`, 「The console plugin bundle」): one ES module, `bundle.js`, its
// stylesheet, `bundle.css`, and its words, `words.json`, into `dist/`, the folder the gate's settings name.

const CLIENT = fileURLToPath(new URL("..", import.meta.url));

// The libraries a console shares with every bundle it loads, left unbundled as the package's own path of what is
// imported, so the console resolves each to the copy its app runs.
const SHARED = ["vue", "vue-router", "vue-i18n", "nuxt/app", "@nuxt/ui", "bmo-ui"];

function shared(id: string): boolean {
  return SHARED.some((name) => id === name || id.startsWith(`${name}/`));
}

// The words, one JSON object: each locale's tree under the locale's code, read from `i18n/<locale>.json`.
function words(): Plugin {
  return {
    name: "gate-console-words",
    generateBundle() {
      const folder = join(CLIENT, "i18n");
      const locales = readdirSync(folder)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((file) => [basename(file, ".json"), JSON.parse(readFileSync(join(folder, file), "utf8")) as unknown]);

      this.emitFile({ type: "asset", fileName: "words.json", source: `${JSON.stringify(Object.fromEntries(locales))}\n` });
    }
  };
}

export default defineConfig({
  root: CLIENT,
  publicDir: false,
  plugins: [vue(), tailwindcss(), words()],
  build: {
    outDir: join(CLIENT, "dist"),
    emptyOutDir: true,
    lib: {
      entry: join(CLIENT, "console", "bundle.ts"),
      formats: ["es"],
      fileName: () => "bundle.js",
      cssFileName: "bundle"
    },
    rollupOptions: { external: shared }
  }
});
