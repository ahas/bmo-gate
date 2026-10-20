import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gateSeconds, roundUnit, roundUnitLine } from "../../../training/tooling/src/reference/round";
import { scratchDir } from "../scratch";
import { useToolingSettings } from "../settings";

useToolingSettings({ data_root: scratchDir("bmo-round-data-") });

test("the round starts as its own unit in the checkout given, carrying the jobs it spares", () => {
  const line = roundUnitLine({ run: "ref-1", spare: ["bmo-task-9"], asked: "2026-10-05T00:00:00.000Z", checkout: "/base/gate", bun: "/bin/bun" });

  expect(line.slice(0, 5)).toEqual(["systemd-run", "--user", "--quiet", "--collect", `--unit=${roundUnit}`]);
  expect(line).toContain("--property=WorkingDirectory=/base/gate");
  expect(line.slice(line.indexOf("/bin/bun"))).toEqual([
    "/bin/bun", "scripts/reference-round.ts", "ref-1", "--in-unit", "--asked", "2026-10-05T00:00:00.000Z", "--spare", "bmo-task-9",
  ]);
});

test("each gate's seconds are read off the training run's ledger, and none where it trained nothing", () => {
  const folder = mkdtempSync(join(tmpdir(), "round-"));

  expect(gateSeconds(folder)).toBeNull();

  writeFileSync(join(folder, "ledger.json"), JSON.stringify({
    rows: [{ gate: "room-rules", node: "node-b", state: "done", seconds: 1200, startedAt: "a", endedAt: "b" }],
  }));

  expect(gateSeconds(folder)).toEqual([{ gate: "room-rules", node: "node-b", state: "done", seconds: 1200, startedAt: "a", endedAt: "b" }]);
});
