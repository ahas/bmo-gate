import { describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The console bundle as its build writes it (bmo-ui's `docs/console-bundles.md`, "What a bundle is"): one ES module
// leaving the libraries a console shares unbundled, its stylesheet, and its words keyed by locale.

const CLIENT = fileURLToPath(new URL("../../../client/", import.meta.url));
const SHARED = ["vue", "vue-router", "vue-i18n", "nuxt/app", "@nuxt/ui", "bmo-ui"];

const out = mkdtempSync(join(tmpdir(), "gate-bundle-"));
const built = Bun.spawnSync(["bun", "x", "vite", "build", "--config", "console/vite.config.ts", "--outDir", out], { cwd: CLIENT });

describe("the built bundle", () => {
  test("builds", () => {
    expect(built.exitCode, `${built.stdout}${built.stderr}`).toBe(0);
  });

  test("is one module whose every import is a shared library's own path", () => {
    const module = readFileSync(join(out, "bundle.js"), "utf8");
    const imported = [...module.matchAll(/(?:^|\n)\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)].map((found) => found[1]!);

    expect(imported.length).toBeGreaterThan(0);

    for (const path of imported) {
      expect(SHARED.some((name) => path === name || path.startsWith(`${name}/`)), path).toBe(true);
    }

    expect(module).not.toMatch(/\bimport\(/);
    expect(module).toMatch(/export\s*\{\s*\w+\s+as\s+default\s*\}/);
  });

  test("routes its screens under the screen path alone", () => {
    const entry = readFileSync(join(CLIENT, "console/bundle.ts"), "utf8");
    const paths = [...entry.matchAll(/path: "([^"]+)"/g)].map((found) => found[1]!);

    expect(paths).toEqual(["/gates", "/gates/:stage"]);
  });

  test("asks for the console's title bar on every route", () => {
    const entry = readFileSync(join(CLIENT, "console/bundle.ts"), "utf8");
    const routes = [...entry.matchAll(/\{ path: "[^"]+"[^\n]*\}/g)].map((found) => found[0]);

    expect(routes.length).toBe(2);

    for (const route of routes) {
      expect(route, route).toContain("meta: { consoleTitleBar: true }");
    }
  });

  test("writes the pages' utilities and none of the theme's variables", () => {
    const stylesheet = readFileSync(join(out, "bundle.css"), "utf8");

    expect(stylesheet).toContain(".text-muted{");
    expect(stylesheet).not.toMatch(/:root\s*[,{]/);
  });

  test("writes its words as one object keyed by locale, every key under its namespace", () => {
    const words = JSON.parse(readFileSync(join(out, "words.json"), "utf8")) as Record<string, Record<string, unknown>>;

    expect(Object.keys(words).sort()).toEqual(["en", "ko"]);

    for (const tree of Object.values(words)) {
      expect(Object.keys(tree)).toEqual(["gates"]);
    }
  });
});
