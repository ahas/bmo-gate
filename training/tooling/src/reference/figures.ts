import { goldYes, referenceGates } from "./labels";

import type { Label, ReferenceGate } from "./labels";
import type { RecordedPick } from "./turns";

// What the labels say about the gates (docs/reference-data.md, 「The figures」). The figures are read
// off the labels, never off the rows, so they are the same whatever the narrowing does today.

export const taus = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99] as const;

// Laya's answer for one turn and gate, per candidate slug: its probability of yes.
export type LayaAnswers = Record<string, number>;

// A reference gate's filter settles it candidate by candidate, so the figures at τ count candidates:
// those whose own confidence reaches τ, their share of the ones Laya answered, how many of them
// matched the gold among the uncontested ones, and the turns every candidate of which reached τ —
// the turns the LLM is not asked at all.
export interface TauFigures {
  tau: number;
  settled: number;
  share: number;
  matchGold: number;
  accuracyGold: number | null;
  wholeTurns: number;
}

// Laya's answer to one candidate: its confidence, and whether it matched the gold where the gold
// is uncontested.
interface LayaCandidate {
  confidence: number;
  right: boolean | null;
}

export interface GateFigures {
  gate: ReferenceGate;
  turns: number;
  attached: number;
  used: number;
  related: number;
  unused: number;
  overSelection: number | null;
  offered: number;
  needed: number;
  missTurns: number;
  // The LLM gate's own set against the use gold, on the turns the reference record holds.
  llmMatchGold: number;
  llmComparable: number;
  llmAccuracyGold: number | null;
  laya: { turns: number; candidates: number; byTau: TauFigures[] } | null;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;
}

// Whether a set of yeses matches the gold on the uncontested, labelled candidates, or null where
// there is nothing to compare.
function matches(labels: readonly Label[], says: (slug: string) => boolean | null): boolean | null {
  let compared = 0;

  for (const label of labels) {
    const gold = goldYes(label.word);
    const said = says(label.slug);

    if (gold === null || said === null) {
      continue;
    }

    compared += 1;

    if (gold !== said) {
      return false;
    }
  }

  return compared === 0 ? null : true;
}

export interface FigureTurn {
  key: string;
  recorded: readonly RecordedPick[];
}

export function gateFigures(
  gate: ReferenceGate,
  turns: readonly FigureTurn[],
  labels: readonly Label[],
  laya: ReadonlyMap<string, LayaAnswers>,
): GateFigures {
  const byTurn = new Map<string, Label[]>();

  for (const label of labels) {
    if (label.gate === gate) {
      byTurn.set(label.turn, [...byTurn.get(label.turn) ?? [], label]);
    }
  }

  const figures: GateFigures = {
    gate, turns: 0, attached: 0, used: 0, related: 0, unused: 0, overSelection: null, offered: 0, needed: 0, missTurns: 0,
    llmMatchGold: 0, llmComparable: 0, llmAccuracyGold: null, laya: null,
  };
  const layaTurns: LayaCandidate[][] = [];

  for (const turn of turns) {
    const mine = byTurn.get(turn.key) ?? [];

    if (mine.length === 0) {
      continue;
    }

    figures.turns += 1;

    for (const label of mine) {
      if (label.attached) {
        figures.attached += 1;

        if (label.word === "used" || label.word === "related" || label.word === "unused") {
          figures[label.word] += 1;
        }
      } else {
        figures.offered += 1;
        figures.needed += label.word === "needed" ? 1 : 0;
      }
    }

    figures.missTurns += mine.some((label) => label.word === "needed") ? 1 : 0;

    const picks = turn.recorded.filter((pick) => pick.gate === gate);

    if (picks.length > 0) {
      const llm = matches(mine, (slug) => picks.find((pick) => pick.slug === slug)?.llm ?? false);

      if (llm !== null) {
        figures.llmComparable += 1;
        figures.llmMatchGold += llm ? 1 : 0;
      }
    }

    const answers = laya.get(`${turn.key}/${gate}`);

    if (answers === undefined || Object.keys(answers).length === 0) {
      continue;
    }

    const gold = new Map(mine.map((label) => [label.slug, goldYes(label.word)]));

    layaTurns.push(Object.entries(answers).map(([slug, yes]) => {
      const wanted = gold.get(slug) ?? null;

      return { confidence: Math.max(yes, 1 - yes), right: wanted === null ? null : (yes >= 0.5) === wanted };
    }));
  }

  figures.overSelection = share(figures.unused, figures.used + figures.related + figures.unused);
  figures.llmAccuracyGold = share(figures.llmMatchGold, figures.llmComparable);

  if (layaTurns.length > 0) {
    const candidates = layaTurns.flat();

    figures.laya = {
      turns: layaTurns.length,
      candidates: candidates.length,
      byTau: taus.map((tau) => {
        const settled = candidates.filter((one) => one.confidence >= tau);
        const judged = settled.filter((one) => one.right !== null);
        const matchGold = judged.filter((one) => one.right === true).length;
        const wholeTurns = layaTurns.filter((turn) => turn.every((one) => one.confidence >= tau)).length;

        return { tau, settled: settled.length, share: share(settled.length, candidates.length) ?? 0, matchGold, accuracyGold: share(matchGold, judged.length), wholeTurns };
      }),
    };
  }

  return figures;
}

// Every turn a label was given on, with what the record says the LLM gate picked there. A turn the
// snapshot no longer yields as one keeps its labels and is counted all the same.
export function labelledTurns(turns: readonly FigureTurn[], labels: readonly Label[]): FigureTurn[] {
  const known = new Map(turns.map((turn) => [turn.key, turn]));

  return [...new Set(labels.map((label) => label.turn))].map((key) => known.get(key) ?? { key, recorded: [] });
}

export function allFigures(turns: readonly FigureTurn[], labels: readonly Label[], laya: ReadonlyMap<string, LayaAnswers>): GateFigures[] {
  return referenceGates.map((gate) => gateFigures(gate, turns, labels, laya));
}

// Laya's answer read off the service's reply, per question name.
export function layaAnswersOf(reply: unknown): LayaAnswers | null {
  const answers = typeof reply === "object" && reply !== null ? (reply as { answers?: unknown }).answers : null;

  if (typeof answers !== "object" || answers === null) {
    return null;
  }

  const read: LayaAnswers = {};

  for (const [slug, answer] of Object.entries(answers as Record<string, unknown>)) {
    const noul = (answer as { noul?: unknown } | null)?.noul;

    if (typeof noul === "number") {
      read[slug] = noul;
    }
  }

  return read;
}
