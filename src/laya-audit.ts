import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { answersOf, languageBuckets, languageOf, stateText, synthesisFor, targetBalance, validateSynthRow } from "./laya-synth";
import { splitFiles } from "./laya-frozen";
import { languageFile, metaFile } from "./laya-synth-run";

import type { DatasetRow, DatasetSplit, Gold } from "./laya-dataset";
import type { GateSynthesis, LanguageBucket, SynthRefusal, SynthRow } from "./laya-synth";

// What a frozen dataset is worth, in numbers rather than in impressions (docs/laya-gates.md). It
// draws a sample per gate and asks it the same questions the generator asked of every row as it
// landed, so the check is the specification itself rather than a second opinion about it: the share
// that still answers its own gate, the answer balance against the even split the specification
// draws to, the rows whose format broke, the transcripts that are not in the gate's real line shape,
// and the three languages against the ratio that gate is drawn to.
//
// The same verb scores a pilot and audits a finished dataset, so the two are measured with one
// yardstick and their figures can be set side by side.

export interface AuditRow {
  row: DatasetRow;
  // What the sidecar says this row's language is, or null where the sidecar does not name it.
  language: LanguageBucket | null;
  // The row read back into the three parts the validator reads, or null where one of them could
  // not be read at all.
  read: SynthRow | null;
}

export interface GateAudit {
  gate: string;
  // Whether this gate has a descriptor at all. A folder can carry a gate this repository does not
  // know, and that is a finding rather than a crash.
  known: boolean;
  rows: number;
  splits: Record<DatasetSplit, number>;
  sampled: number;
  // Rows whose state, questions or gold could not be read as JSON at all, which is a broken row
  // rather than a wrong one.
  unreadable: number;
  conforming: number;
  conformance: number;
  refused: Partial<Record<SynthRefusal, number>>;
  // Called out on its own because it is the one way a row can be wrong that a person can see at a
  // glance and a model gets wrong in bulk.
  transcriptBroken: number;
  transcriptShare: number;
  balance: Record<string, number>;
  balanceTarget: Record<string, number>;
  balanceDrift: number;
  language: Record<LanguageBucket, number>;
  languageTarget: Record<LanguageBucket, number>;
  languageDrift: number;
  // Rows whose sidecar language is not what the row's own text reads as now.
  sidecarMismatch: number;
  floors: FloorReading;
  // What the model wrote for this gate against what survived, read off the run's own meta. The
  // sample above is drawn from rows that already passed the generator, so on a folder this
  // repository wrote it can only come out whole; the share that was thrown away on the way in is
  // the figure that says whether the model was any good, and only the meta still holds it.
  generation: GenerationReading | null;
}

export interface GenerationReading {
  written: number;
  kept: number;
  keptShare: number;
  unreadable: number;
  refused: Partial<Record<SynthRefusal, number>>;
  // Rows the model wrote that it had already written. A model repeating itself is the one flaw
  // that costs nothing at the time and hollows out the dataset later.
  duplicates: number;
  duplicateShare: number;
  // What share of what was written broke the format outright — a transcript in the wrong shape, or
  // a row that could not be read as a row at all.
  formatBreakShare: number;
}

// What the item asks of a finished gate, counted over every row rather than over the sample.
export interface FloorReading {
  train: number;
  minority: number;
  evaluation: number;
  met: boolean;
}

export interface Audit {
  folder: string;
  seed: string;
  sample: number;
  gates: GateAudit[];
}

// A sample nobody can draw again is an anecdote. The seed is reported with the figures and drawing
// with it again gives the same rows.
export function seededRandom(seed: string): () => number {
  let held = 2_166_136_261;

  for (const letter of seed) {
    held ^= letter.charCodeAt(0);
    held = Math.imul(held, 16_777_619);
  }

  return () => {
    held = (held + 0x6d2b79f5) | 0;

    let mixed = held;

    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Without replacement, and the whole list where fewer rows stand than were asked for.
export function sampleOf<Item>(items: readonly Item[], count: number, seed: string): Item[] {
  const drawn = [...items];
  const wanted = count <= 0 ? drawn.length : Math.min(count, drawn.length);
  const roll = seededRandom(seed);

  for (let index = 0; index < wanted; index += 1) {
    const pick = index + Math.floor(roll() * (drawn.length - index));

    [drawn[index], drawn[pick]] = [drawn[pick]!, drawn[index]!];
  }

  return drawn.slice(0, wanted);
}

function readRow(row: DatasetRow): SynthRow | null {
  try {
    const read = {
      state: JSON.parse(row.state) as SynthRow["state"],
      questions: JSON.parse(row.questions) as SynthRow["questions"],
      gold: JSON.parse(row.gold) as SynthRow["gold"],
    };

    return typeof read.questions !== "object" || read.questions === null || typeof read.gold !== "object" || read.gold === null
      ? null
      : read;
  } catch {
    return null;
  }
}

// Everything a frozen folder holds, the three splits and the language sidecar together. A line that
// is not a row at all is counted rather than thrown away, since that is itself a figure.
export function readFrozen(folder: string): { rows: AuditRow[]; broken: number } {
  const languages = new Map<string, LanguageBucket>();
  const sidecar = join(folder, languageFile);

  if (existsSync(sidecar)) {
    for (const line of lines(sidecar)) {
      try {
        const one = JSON.parse(line) as { id: string; language: LanguageBucket };

        languages.set(one.id, one.language);
      } catch {
        // A sidecar line that cannot be read names no row, so no row loses its language by it.
      }
    }
  }

  const rows: AuditRow[] = [];
  let broken = 0;

  for (const name of Object.values(splitFiles)) {
    const path = join(folder, name);

    if (!existsSync(path)) {
      continue;
    }

    for (const line of lines(path)) {
      let row: DatasetRow;

      try {
        row = JSON.parse(line) as DatasetRow;
      } catch {
        broken += 1;
        continue;
      }

      if (typeof row.id !== "string" || typeof row.gate !== "string") {
        broken += 1;
        continue;
      }

      rows.push({ row, language: languages.get(row.id) ?? null, read: readRow(row) });
    }
  }

  return { rows, broken };
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
}

// How many rows carry the gate's rarer answer. A gate asking one question a candidate counts the
// rows that answered yes to something against the rows that answered yes to nothing; a gate asking
// of the whole state counts each answer's own rows. Both are what the specification's floor means
// for that shape of gate.
export function minorityRows(spec: GateSynthesis, rows: readonly AuditRow[]): number {
  const read = rows.map((one) => one.read).filter((one): one is SynthRow => one !== null);

  if (spec.perCandidate) {
    const any = read.filter((one) => Object.values(one.gold).some((gold) => gold.label === "true")).length;

    return Math.min(any, read.length - any);
  }

  const question = spec.questions[0]!;
  const counts = answersOf(question).map((answer) =>
    read.filter((one) => one.gold[question.id]?.label === answer).length);

  return counts.length === 0 ? 0 : Math.min(...counts);
}

export const auditFloors = { train: 4_000, minority: 1_000, evaluation: 1_000 } as const;

function floorsFor(spec: GateSynthesis | null, rows: readonly AuditRow[], splits: Record<DatasetSplit, number>): FloorReading {
  const minority = spec === null ? 0 : minorityRows(spec, rows.filter((one) => one.row.split === "train"));
  const reading = { train: splits.train, minority, evaluation: splits.test };

  return {
    ...reading,
    met: reading.train >= auditFloors.train && reading.minority >= auditFloors.minority && reading.evaluation >= auditFloors.evaluation,
  };
}

function shares(counted: Record<string, number>, total: number): Record<string, number> {
  return Object.fromEntries(Object.entries(counted).map(([key, count]) => [key, round(total === 0 ? 0 : count / total)]));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function drift(reached: Record<string, number>, target: Record<string, number>): number {
  const keys = new Set([...Object.keys(reached), ...Object.keys(target)]);

  return round(Math.max(0, ...[...keys].map((key) => Math.abs((reached[key] ?? 0) - (target[key] ?? 0)))));
}

// One gate's figures. The sample is what the shares are read off; the row counts and the floors are
// read off everything, because a floor is about the dataset and not about the sample.
export function auditGate(gate: string, all: readonly AuditRow[], sample: number, seed: string, folder: string | null = null): GateAudit {
  const spec = synthesisFor(gate);
  const mine = all.filter((one) => one.row.gate === gate);
  const splits: Record<DatasetSplit, number> = { train: 0, calibration: 0, test: 0 };

  for (const one of mine) {
    if (one.row.split in splits) {
      splits[one.row.split] += 1;
    }
  }

  const drawn = sampleOf(mine, sample, `${seed}:${gate}`);
  const refused: Partial<Record<SynthRefusal, number>> = {};
  const answers: Record<string, number> = {};
  const languages: Record<LanguageBucket, number> = { korean: 0, english: 0, mixed: 0 };
  let unreadable = 0;
  let conforming = 0;
  let transcriptBroken = 0;
  let sidecarMismatch = 0;
  let asked = 0;

  for (const one of drawn) {
    if (one.read === null) {
      unreadable += 1;
      continue;
    }

    const reads = languageOf(spec === null ? "" : stateText(spec, one.read.state));

    languages[reads] += 1;

    if (one.language !== null && one.language !== reads) {
      sidecarMismatch += 1;
    }

    for (const gold of Object.values(one.read.gold) as Gold[]) {
      answers[gold.label] = (answers[gold.label] ?? 0) + 1;
      asked += 1;
    }

    if (spec === null) {
      continue;
    }

    // The language a row was asked for is not kept, so it is handed its own language here: the
    // language check cannot fire, and the split against the gate's ratio is reported on its own.
    const verdict = validateSynthRow(spec, one.read, reads);

    if (verdict.ok) {
      conforming += 1;
    } else {
      refused[verdict.refusal] = (refused[verdict.refusal] ?? 0) + 1;

      if (verdict.refusal === "wrong-transcript") {
        transcriptBroken += 1;
      }
    }
  }

  const judged = drawn.length - unreadable;
  const balance = shares(answers, asked);
  const balanceTarget = spec === null ? {} : targetBalance(spec.questions[0]!);
  const language = shares(languages, judged) as Record<LanguageBucket, number>;
  const languageTarget = spec === null
    ? { korean: 0, english: 0, mixed: 0 }
    : Object.fromEntries(languageBuckets.map((bucket) => [bucket, spec.language[bucket]])) as Record<LanguageBucket, number>;

  return {
    gate,
    known: spec !== null,
    rows: mine.length,
    splits,
    sampled: drawn.length,
    unreadable,
    conforming,
    conformance: round(judged === 0 ? 0 : conforming / judged),
    refused,
    transcriptBroken,
    transcriptShare: round(judged === 0 ? 0 : transcriptBroken / judged),
    balance,
    balanceTarget,
    balanceDrift: spec === null ? 0 : drift(balance, balanceTarget),
    language,
    languageTarget,
    languageDrift: spec === null ? 0 : drift(language, languageTarget),
    sidecarMismatch,
    floors: floorsFor(spec, mine, splits),
    generation: folder === null ? null : generationOf(folder, gate),
  };
}

// What the run that wrote this folder said it threw away. A folder with no meta beside it — one
// carried in from somewhere else — simply has no such figure, and says so rather than showing a
// zero that would read as nothing having been thrown away.
export function generationOf(folder: string, gate: string): GenerationReading | null {
  const path = join(folder, metaFile);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { gates?: { gate: string; kept?: number; unreadable?: number; duplicates?: number; refused?: Record<string, number> }[] };
    const mine = meta.gates?.find((one) => one.gate === gate);

    if (mine === undefined) {
      return null;
    }

    const refused = mine.refused ?? {};
    const thrown = Object.values(refused).reduce((sum, count) => sum + count, 0);
    const kept = mine.kept ?? 0;
    const unreadable = mine.unreadable ?? 0;
    const duplicates = mine.duplicates ?? 0;
    const written = kept + thrown + unreadable;
    const broken = (refused["wrong-transcript"] ?? 0) + unreadable;

    return {
      written,
      kept,
      keptShare: round(written === 0 ? 0 : kept / written),
      unreadable,
      refused,
      duplicates,
      duplicateShare: round(written === 0 ? 0 : duplicates / written),
      formatBreakShare: round(written === 0 ? 0 : broken / written),
    };
  } catch {
    return null;
  }
}

export interface AuditOptions {
  folder: string;
  sample: number;
  seed: string;
  gates?: readonly string[];
}

export function auditFrozen(options: AuditOptions): Audit {
  const { rows } = readFrozen(options.folder);
  const present = [...new Set(rows.map((one) => one.row.gate))].sort();
  const wanted = options.gates === undefined || options.gates.length === 0 ? present : present.filter((gate) => options.gates!.includes(gate));

  return {
    folder: options.folder,
    seed: options.seed,
    sample: options.sample,
    gates: wanted.map((gate) => auditGate(gate, rows, options.sample, options.seed, options.folder)),
  };
}

// A seed nobody gave, made once and printed with the figures, so the sample can be drawn again.
export function freshSeed(now: number = Date.now()): string {
  return now.toString(36);
}

export function auditLines(audit: Audit): string[] {
  const said = [
    `${audit.folder}`,
    `표본 ${audit.sample === 0 ? "전부" : audit.sample}행, 씨앗 ${audit.seed} — 같은 씨앗으로 같은 표본을 다시 뽑습니다.`,
    "",
  ];

  if (audit.gates.length === 0) {
    said.push("굳은 행이 없습니다.");

    return said;
  }

  for (const gate of audit.gates) {
    said.push(...gateLines(gate), "");
  }

  return said;
}

function gateLines(gate: GateAudit): string[] {
  if (!gate.known) {
    return [`${gate.gate}: 규격이 없는 게이트입니다. ${gate.rows}행이 들어 있지만 견줄 규격이 없습니다.`];
  }

  const refused = Object.entries(gate.refused).map(([why, count]) => `${why} ${count}`).join(", ");
  const floors = gate.floors;
  const made = gate.generation;
  const written = made === null
    ? ["  지은 것 가운데 산 비율: 이 폴더에는 실행 기록이 없어 알 수 없습니다."]
    : [
        `  모델이 지은 ${made.written}행 가운데 산 것 ${made.kept} (${percent(made.keptShare)}), 어긋난 비율 ${percent(1 - made.keptShare)}` +
          ` · 읽지 못한 것 ${made.unreadable} · 형식 깨짐 ${percent(made.formatBreakShare)} · 겹침 ${made.duplicates} (${percent(made.duplicateShare)})` +
          ` · 버린 까닭: ${namedCounts(made.refused)}`,
      ];

  return [
    `${gate.gate}`,
    ...written,
    `  행 ${gate.rows} (학습 ${gate.splits.train} · 보정 ${gate.splits.calibration} · 시험 ${gate.splits.test})` +
      ` · 바닥 ${floors.met ? "넘김" : "못 넘김"} (학습 ${floors.train}/${auditFloors.train} · 적은 쪽 ${floors.minority}/${auditFloors.minority} · 평가 ${floors.evaluation}/${auditFloors.evaluation})`,
    `  표본 ${gate.sampled}행 가운데 규격에 맞는 것 ${gate.conforming} (${percent(gate.conformance)}), 어긋난 비율 ${percent(1 - gate.conformance)}`,
    `  읽지 못한 행 ${gate.unreadable} · 전사 모양이 틀린 행 ${gate.transcriptBroken} (${percent(gate.transcriptShare)}) · 사이드카 어긋남 ${gate.sidecarMismatch}`,
    `  굳은 것을 다시 본 까닭: ${refused === "" ? "없음" : refused}`,
    `  답 비율 ${pairs(gate.balance)} (목표 ${pairs(gate.balanceTarget)}, 가장 먼 것 ${percent(gate.balanceDrift)})`,
    `  언어 ${pairs(gate.language)} (목표 ${pairs(gate.languageTarget)}, 가장 먼 것 ${percent(gate.languageDrift)})`,
  ];
}

function namedCounts(counted: Record<string, number>): string {
  const written = Object.entries(counted).map(([why, count]) => `${why} ${count}`);

  return written.length === 0 ? "없음" : written.join(", ");
}

function pairs(counted: Record<string, number>): string {
  const written = Object.entries(counted).map(([key, value]) => `${key} ${percent(value)}`);

  return written.length === 0 ? "없음" : written.join(" · ");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
