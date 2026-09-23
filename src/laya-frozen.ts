import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { DatasetSplit } from "./laya-dataset";

// The shape every frozen Laya dataset folder takes, and the one refusal that keeps a frozen one
// from being written over. Three scripts write such a folder — the export, the teacher's pass and
// the synthesis — and a dataset is the thing a training run is bound to for as long as that run's
// figures are believed, so none of the three may quietly replace one.

export const splitFiles: Record<DatasetSplit, string> = {
  train: "train.jsonl",
  calibration: "calibration.jsonl",
  test: "test.jsonl",
};

export const overwriteFlag = "--overwrite";

export function frozenHere(folder: string): boolean {
  return Object.values(splitFiles).some((name) => existsSync(join(folder, name)));
}

// What stands in a folder, so a refusal names it rather than saying only that something is there.
// A file of rows is counted, because the count is what tells a dataset worth keeping from a stub.
// A hidden file is nobody's dataset — it is the machinery of whatever made the folder — and naming
// one in a refusal tells the reader nothing about what they are being kept from writing over.
export function whatStands(folder: string): string[] {
  if (!existsSync(folder)) {
    return [];
  }

  return readdirSync(folder).filter((name) => !name.startsWith(".")).sort().map((name) => {
    const path = join(folder, name);

    if (!name.endsWith(".jsonl")) {
      return name;
    }

    try {
      return `${name} (${readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length}행)`;
    } catch {
      return name;
    }
  });
}

// Null where the folder may be written, and the refusal to print where it may not. The flag that
// would allow it is named in the refusal, so nobody has to go looking for how to say they meant it.
export function refuseOverwrite(folder: string, overwrite: boolean): string | null {
  if (overwrite || !frozenHere(folder)) {
    return null;
  }

  return [
    `${folder} 에 이미 굳은 데이터가 있습니다: ${whatStands(folder).join(", ")}`,
    `덮어쓰려면 ${overwriteFlag} 를 주세요. 주지 않으면 아무것도 쓰지 않습니다.`,
  ].join("\n");
}
