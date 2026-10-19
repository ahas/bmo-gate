import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { unitRoot } from "../../training/tooling/src/roots";
import { scratchDir } from "./scratch";

function git(cwd: string, ...args: string[]): void {
  const done = Bun.spawnSync(["git", "-c", "user.name=tester", "-c", "user.email=tester@example.com", ...args], { cwd, stdin: "ignore" });

  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
}

describe("where a unit of this project is linked from", () => {
  test("is this directory in the main worktree, whichever worktree asks", () => {
    const place = realpathSync(scratchDir("bmo-gate-roots-"));
    const main = join(place, "main");
    const support = join(place, "support");

    mkdirSync(join(main, "gate"), { recursive: true });
    writeFileSync(join(main, "gate", "unit.service"), "");
    git(main, "init", "-q", "-b", "main");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "first");
    git(main, "worktree", "add", "-q", "--detach", support, "main");

    expect(unitRoot(join(support, "gate"))).toBe(join(main, "gate"));
    expect(unitRoot(join(main, "gate"))).toBe(join(main, "gate"));
  });

  test("is the directory itself outside a git checkout", () => {
    const place = realpathSync(scratchDir("bmo-gate-roots-bare-"));

    expect(unitRoot(place)).toBe(place);
  });
});
