import { createHash } from "node:crypto";

// What a frozen row is and which of the three parts of a dataset it falls in. The rows a generation
// writes take this shape because it is the shape the training reads.

export interface DatasetRow {
  id: string;
  // The gate the row came from, which the training reads to balance one gate against another.
  gate: string;
  split: DatasetSplit;
  state: string;
  questions: string;
  gold: string;
}

export type Gold =
  | { type: "noul"; label: "true" | "false"; noul: number; probabilities: { true: number; false: number } }
  | { type: "choice"; label: string; probabilities: Record<string, number> };

// Training teaches the model, calibration fits its temperatures and test measures it; a figure read
// off rows the model learnt from or was fitted on says nothing about the rows it will meet.
export const datasetSplits = ["train", "calibration", "test"] as const;

export type DatasetSplit = (typeof datasetSplits)[number];

export interface SplitShares {
  calibration: number;
  test: number;
}

// Which split an input falls in, fixed by its hash, so one input never sits in two and a row keeps
// its split however the data grows.
export function splitOf(inputHash: string, shares: SplitShares): DatasetSplit {
  const place = Number.parseInt(createHash("sha256").update(inputHash).digest("hex").slice(0, 8), 16) / 0x1_0000_0000;

  if (place < shares.test) {
    return "test";
  }

  return place < shares.test + shares.calibration ? "calibration" : "train";
}
