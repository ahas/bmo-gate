import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { optionalText, settingsPath, SettingsRefused } from "./settings";

// Where a run's bytes go. Anything a command writes is runtime data: it outlives the run that wrote it, and
// what sits untracked inside a checkout is one `git clean` from gone. So none of it is written here.

/** The tooling's own folder, `training/tooling/` of the repository. */
export function sourceRoot(): string {
  return dirname(import.meta.dir);
}

/** The repository the tooling stands in, whose `runtime/` and `training/` folders hold what goes to a node. */
export function repositoryRoot(): string {
  return dirname(dirname(sourceRoot()));
}

// Where a unit of this project is linked from: this directory in the repository's main worktree, the
// base checkout, whichever checkout the command runs in. A support worktree is a job's, moved from
// branch to branch, and a unit linked into it would run whatever that job left there. Outside a git
// checkout it is this directory itself.
export function unitRoot(from: string = sourceRoot()): string {
  const ask = (args: string[]): string | null => {
    const done = Bun.spawnSync(["git", ...args], { cwd: from, stdin: "ignore" });

    return done.exitCode === 0 ? done.stdout.toString().trim() : null;
  };
  const common = ask(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const top = ask(["rev-parse", "--show-toplevel"]);

  return common === null || top === null ? from : join(dirname(common), relative(top, from));
}

// The home directory as the environment names it now. A process that has moved its home since it
// started — a test among them — must see the move, so `HOME` is asked on every call rather than read
// once.
export function homeDir(): string {
  const named = process.env.HOME;

  return named === undefined || named === "" ? homedir() : named;
}

/** The runtime data root: `BMO_DATA_DIR` where it is set, as the units set it, else the settings'
 * `data_root`; with neither, the command that needs it stops (docs/training.md, 「The tooling and its
 * settings」). */
export function dataRoot(): string {
  const named = process.env.BMO_DATA_DIR;

  if (named !== undefined && named !== "") {
    return resolve(named);
  }

  const set = optionalText("data_root");

  if (set === null) {
    throw new SettingsRefused(`no data root: BMO_DATA_DIR is not set and ${settingsPath()} gives no data_root`);
  }

  return resolve(set);
}

// A place under the runtime data root, named part by part.
export function dataPath(...parts: string[]): string {
  return join(dataRoot(), ...parts);
}

// A worker's workbench: what its runs keep across sessions — collected checkpoints among them.
// Under the data root so no checkout holds it, since what sits untracked inside a checkout is one
// `git clean` from gone.
export function workbenchPath(worker: string): string {
  return dataPath("workbench", worker);
}
