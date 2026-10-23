import { describe, expect, test } from "bun:test";

// The gates' pages, read off the files the bundle ships: one source serves the module the gate answers and the layer
// a host extends, so each page imports what it uses and reads the gate through the console's relay alone.

const pages = {
  order: await Bun.file(new URL("../../../client/app/pages/gates/index.vue", import.meta.url)).text(),
  trials: await Bun.file(new URL("../../../client/app/pages/gates/[stage].vue", import.meta.url)).text()
};

// The components a template names, as `<UButton` or `<ContentSkeleton`.
function componentsOf(source: string): string[] {
  const template = source.slice(0, source.indexOf("<script"));

  return [...new Set([...template.matchAll(/<([A-Z][A-Za-z]+)/g)].map((found) => found[1]!))];
}

describe.each(Object.entries(pages))("the %s page", (_name, source) => {
  test("imports every component it draws", () => {
    for (const component of componentsOf(source)) {
      expect(source).toMatch(new RegExp(`import ${component} from "(?:@nuxt/ui/components|bmo-ui/app/components)/[A-Za-z]+\\.vue";`));
    }
  });

  test("leans on no auto-import, no compiler macro and no host's own component", () => {
    expect(source).toContain('from "vue";');
    expect(source).toContain('import { useI18n } from "vue-i18n";');
    expect(source).not.toContain("definePageMeta");
    expect(source).not.toContain("$t(");
    expect(source).not.toMatch(/from "(?:~|@|#shared|#imports|#app)\//);
  });

  test("reads the gate at the relay's address for its screen routes alone", () => {
    // What each call is handed as its address: the argument up to its first comma, a call within it whole.
    const calls = [...source.matchAll(/\$fetch<\w+>\(((?:[^,()]|\([^()]*\))+)/g)].map((found) => found[1]);

    expect(calls.length).toBeGreaterThan(0);

    for (const call of calls) {
      expect(call).toMatch(/^gateAddress\("\/(?:gates|laya|trials)"\)$/);
    }
  });
});

describe("the trial page", () => {
  test("puts a trial with the gate and the prompt alone, the reader being the console's to name", () => {
    expect(pages.trials).toContain('$fetch<Trial>(gateAddress("/trials"), { method: "POST", body: { gateName, prompt } })');
  });
});
