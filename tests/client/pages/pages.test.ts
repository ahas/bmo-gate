import { describe, expect, test } from "bun:test";

// The gate trial page, read off the file the bundle ships: what it asks of the host, and where it reads and writes.

const source = await Bun.file(new URL("../../../client/app/pages/gates/[stage].vue", import.meta.url)).text();
const template = source.slice(0, source.indexOf("<script"));

describe("this gate's own settings", () => {
  test("stand behind one button beside the gate's name", () => {
    const trailing = template.slice(template.indexOf("<template #trailing>"), template.indexOf("<template #right>"));

    expect(trailing).toContain(`<UTooltip :text="$t('gates.action.settings')">`);
    expect(trailing).toContain(`:aria-label="$t('gates.action.settings')"`);
  });

  test("are the host's gate settings dialog for this gate, not an editor of this page's own", () => {
    expect(template).toContain('<GateSettingsDialog v-model:open="settingsOpen" :gate="stage" />');
    expect(source).not.toContain("/api/fallback");
    expect(source).not.toContain("/api/model-tiers");
  });
});

describe("what the page reads and writes", () => {
  test("goes through the bundle's own server routes alone", () => {
    const calls = source.split("$fetch<").slice(1);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toStartWith('Trial>("/api/gate", { method: "POST"');
    expect(calls[1]).toStartWith("Trial[]>(`/api/gate/${encodeURIComponent(stage)}`)");
    expect(calls[2]).toStartWith('LayaView>("/api/laya")');
  });

  test("reaches no file of the host's by its aliases", () => {
    expect(source).not.toMatch(/from "(?:~|@|#shared)\//);
  });
});
