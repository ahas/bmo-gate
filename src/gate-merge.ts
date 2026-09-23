import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { refuseOverwrite, splitFiles } from "./laya-frozen";
import { rehearsalMetaFile } from "./laya-rehearsal";
import { addTokens, languageFile, metaFile, noTokens, roadsOf } from "./laya-synth-run";
import { gateFolder, gatesFolderName } from "./roots";

import type { DatasetRow, DatasetSplit } from "./laya-dataset";
import type { LanguageBucket } from "./laya-synth";
import type { SynthMeta, TokenTally } from "./laya-synth-run";

// The ten gates into the one dataset (docs/gate-data.md 「A run folder」). Each gate freezes its own
// three splits because each gate is its own generation; the training driver reads one folder and
// cuts it by each row's own gate, so the splits it needs are the ten gates' rows together.
//
// Nothing here rewrites a row. A row frozen by its gate is the row that lands in the dataset, and
// the merge only decides which folders go in and whether they belong to one another.

export interface MergeOptions {
  // The run's folder, which is where the gates' own folders stand.
  root: string;
  // Where the merged dataset goes.
  into: string;
  // The gates to merge, or null for every gate that has frozen something.
  gates: readonly string[] | null;
  overwrite: boolean;
}

export interface MergeReport {
  folder: string;
  meta: SynthMeta;
  gates: string[];
  rows: Record<DatasetSplit, number>;
  // Row ids that stood in two folders at once. The ids carry their gate, so this is zero unless
  // two folders are claiming the same rows, which is worth saying out loud rather than folding
  // into a gate's own duplicate count — that one means the model wrote a row twice, and the bar
  // for repeats is read off it.
  duplicates: number;
}

// What a gate's frozen folder holds, as the merge reads it.
interface GatePart {
  gate: string;
  folder: string;
  meta: SynthMeta;
  rows: Record<DatasetSplit, DatasetRow[]>;
  languages: Map<string, LanguageBucket>;
}

function readLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "") : [];
}

// Every gate that has frozen something under a run, in the order the folder names sort. Used when
// nothing named which gates to merge, so a run merges what it actually wrote.
export function frozenGatesUnder(root: string): string[] {
  const gates = join(root, gatesFolderName);

  if (!existsSync(gates)) {
    return [];
  }

  return readdirSync(gates).sort().filter((gate) => existsSync(join(gates, gate, splitFiles.train)));
}

function readPart(root: string, gate: string): GatePart | string {
  const folder = gateFolder(root, gate);
  const meta = join(folder, metaFile);

  if (!existsSync(meta)) {
    return `${gate}: ${folder} 에 굳은 데이터가 없습니다.`;
  }

  if (existsSync(join(folder, rehearsalMetaFile))) {
    return `${gate}: 리허설 데이터입니다. 진짜 데이터와 섞을 수 없습니다.`;
  }

  const rows = { train: [], calibration: [], test: [] } as Record<DatasetSplit, DatasetRow[]>;

  for (const [split, name] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
    for (const line of readLines(join(folder, name))) {
      const row = JSON.parse(line) as DatasetRow & { rehearsal?: boolean };

      // A rehearsal row travels with its own mark, and one of them anywhere in a dataset is
      // enough for the training driver to read the whole thing as a rehearsal.
      if (row.rehearsal === true) {
        return `${gate}: ${name} 에 리허설 행이 섞여 있습니다.`;
      }

      if (row.gate !== gate) {
        return `${gate}: ${name} 에 ${row.gate} 게이트의 행이 있습니다.`;
      }

      rows[split].push(row);
    }
  }

  const languages = new Map<string, LanguageBucket>();

  for (const line of readLines(join(folder, languageFile))) {
    const said = JSON.parse(line) as { id: string; language: LanguageBucket };

    languages.set(said.id, said.language);
  }

  return { gate, folder, meta: JSON.parse(readFileSync(meta, "utf8")) as SynthMeta, rows, languages };
}

// The fields that say the parts belong to one run. A dataset stitched from two runs is not one
// dataset — its figures are the average of two different things and belong to neither — so the
// parts must agree on every one of these before they are put together.
//
// The road, the model and the effort are not among them: a gate carries its own, and one run may
// build different gates on different roads on purpose. Sanitizer is written on J3090 while the
// other nine ride codex, because codex refuses sanitizer's attack rows at the account level; the
// gates still merge into one dataset, since what makes them one run is the row count, the batch
// size and the split shares they were all cut to, not the model that wrote each one. What road
// wrote what is kept — every part's roads are gathered onto the merged meta — rather than enforced.
const runWide = ["rowsAsked", "batchSize"] as const;

function refuseDisagreement(parts: readonly GatePart[]): string | null {
  const first = parts[0]!;

  for (const part of parts.slice(1)) {
    for (const field of runWide) {
      if (part.meta[field] !== first.meta[field]) {
        return `${part.gate} 의 ${field} 는 ${String(part.meta[field])} 인데 ${first.gate} 는 ${String(first.meta[field])} 입니다. 다른 실행의 데이터는 하나로 묶지 않습니다.`;
      }
    }

    for (const share of ["calibration", "test"] as const) {
      if (part.meta.shares[share] !== first.meta.shares[share]) {
        return `${part.gate} 의 ${share} 몫은 ${part.meta.shares[share]} 인데 ${first.gate} 는 ${first.meta.shares[share]} 입니다. 다른 실행의 데이터는 하나로 묶지 않습니다.`;
      }
    }
  }

  return null;
}

// The merge, or the refusal to make one. Every refusal is a sentence saying what is wrong, because
// a merge that goes ahead on parts that do not belong together produces a dataset nobody can tell
// is wrong by looking at it.
export function mergeGates(options: MergeOptions): MergeReport | string {
  const wanted = options.gates ?? frozenGatesUnder(options.root);

  if (wanted.length === 0) {
    return `${options.root} 아래에 굳은 게이트가 없습니다.`;
  }

  const parts: GatePart[] = [];

  for (const gate of wanted) {
    const part = readPart(options.root, gate);

    if (typeof part === "string") {
      return part;
    }

    parts.push(part);
  }

  const disagreement = refuseDisagreement(parts);

  if (disagreement !== null) {
    return disagreement;
  }

  const refusal = refuseOverwrite(options.into, options.overwrite);

  if (refusal !== null) {
    return refusal;
  }

  const seen = new Set<string>();
  const kept = { train: [], calibration: [], test: [] } as Record<DatasetSplit, DatasetRow[]>;
  const languages: string[] = [];
  let duplicates = 0;

  for (const part of parts) {
    for (const split of Object.keys(splitFiles) as DatasetSplit[]) {
      for (const row of part.rows[split]) {
        if (seen.has(row.id)) {
          duplicates += 1;

          continue;
        }

        seen.add(row.id);
        kept[split].push(row);

        const language = part.languages.get(row.id);

        if (language !== undefined) {
          languages.push(JSON.stringify({ id: row.id, language }));
        }
      }
    }
  }

  const first = parts[0]!;
  const meta: SynthMeta = {
    model: first.meta.model,
    effort: first.meta.effort,
    road: first.meta.road,
    // Every road any gate was written on, so a dataset built across roads says so plainly rather
    // than reading as though the first gate's road wrote all of it.
    roads: [...new Set(parts.flatMap((part) => roadsOf(part.meta)))].sort(),
    sessionHeld: parts.every((part) => part.meta.sessionHeld),
    cacheReused: parts.every((part) => part.meta.cacheReused),
    written: new Date().toISOString(),
    // The run began when the first of its gates began, whichever gate that was.
    started: parts.map((part) => part.meta.started).sort()[0]!,
    rowsAsked: first.meta.rowsAsked,
    batchSize: first.meta.batchSize,
    shares: first.meta.shares,
    gates: parts.flatMap((part) => part.meta.gates),
    tokens: parts.reduce<TokenTally>((all, part) => addTokens(all, part.meta.tokens), noTokens),
  };

  mkdirSync(options.into, { recursive: true });

  for (const [split, name] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
    const lines = kept[split].map((row) => JSON.stringify(row));

    writeFileSync(join(options.into, name), lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  }

  writeFileSync(join(options.into, languageFile), languages.length === 0 ? "" : `${languages.join("\n")}\n`);
  writeFileSync(join(options.into, metaFile), `${JSON.stringify(meta, null, 2)}\n`);

  return {
    folder: options.into,
    meta,
    gates: parts.map((part) => part.gate),
    rows: { train: kept.train.length, calibration: kept.calibration.length, test: kept.test.length },
    duplicates,
  };
}

// Whether the training driver could cut a gate out of this folder. It wants each of the three
// splits to hold at least one row of that gate and refuses the gate outright otherwise, so a
// dataset short in any one of them is a dataset that trains nine gates and names the tenth as a
// fault. Said here as a reading rather than found out by a training run failing.
export function gatesTrainingWouldRefuse(folder: string, gates: readonly string[]): string[] {
  const holds = new Map<string, Set<DatasetSplit>>();

  for (const [split, name] of Object.entries(splitFiles) as [DatasetSplit, string][]) {
    for (const line of readLines(join(folder, name))) {
      const row = JSON.parse(line) as DatasetRow;

      (holds.get(row.gate) ?? holds.set(row.gate, new Set()).get(row.gate)!).add(split);
    }
  }

  return gates.filter((gate) => (holds.get(gate)?.size ?? 0) < Object.keys(splitFiles).length);
}

// Whether the folder would be read as a rehearsal rather than as the real data. The mark travels
// two ways — a meta file of its own, and a mark on the rows themselves — so both are looked for.
export function readsAsRehearsal(folder: string): boolean {
  if (existsSync(join(folder, rehearsalMetaFile))) {
    return true;
  }

  for (const name of Object.values(splitFiles)) {
    const lines = readLines(join(folder, name));

    if (lines.length > 0) {
      return (JSON.parse(lines[0]!) as { rehearsal?: boolean }).rehearsal === true;
    }
  }

  return false;
}
