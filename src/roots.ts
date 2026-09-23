import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Where a run's bytes go. A frozen dataset is runtime data: it outlives the run that wrote it, a
// training run is bound to it for as long as anyone believes that run's figures, and what sits
// untracked inside a checkout is one `git clean` from gone. So none of it is written here.

export function sourceRoot(): string {
  return dirname(import.meta.dir);
}

// The home directory as the environment names it now. A process that has moved its home since it
// started — a test, whose preload moves it before its first line — must see the move, so `HOME` is
// asked on every call rather than read once.
export function homeDir(): string {
  const named = process.env.HOME;

  return named === undefined || named === "" ? homedir() : named;
}

// The root the bot's runtime data stands under, shared with everything else that writes there.
export function dataRoot(): string {
  const named = process.env.BMO_DATA_DIR;

  return named === undefined || named === "" ? join(homeDir(), ".local", "share", "bmo", "data") : resolve(named);
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

// Where the frozen datasets live, which is also where the training driver goes looking.
export function synthRoot(): string {
  return join(dataRoot(), "laya-synth");
}

// A run's own folder. A bare name is a name under the data root; a path is taken as given, so a
// run can be put somewhere else outright.
export function runFolder(name: string): string {
  return name.startsWith("/") ? name : join(synthRoot(), name);
}

export const gatesFolderName = "gates";
export const datasetFolderName = "dataset";

// One gate's folder. Each gate keeps its own thread, its own batches and its own progress, so
// nothing one gate writes is ever read or written by another.
export function gateFolder(root: string, gate: string): string {
  return join(root, gatesFolderName, gate);
}

// Where the gates are merged into the one dataset the training driver is handed.
export function datasetFolder(root: string): string {
  return join(root, datasetFolderName);
}

// The refusal to write a run into the checkout, or null where the folder is somewhere it may go.
export function refuseInsideCheckout(folder: string): string | null {
  const inside = resolve(folder);

  if (inside !== sourceRoot() && !inside.startsWith(`${sourceRoot()}/`)) {
    return null;
  }

  return [
    `${folder} 는 체크아웃 안입니다. 굳은 데이터는 런타임 데이터입니다.`,
    `이름만 주면 ${synthRoot()} 아래에 씁니다.`,
  ].join("\n");
}
