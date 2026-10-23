import { relayAddress } from "bmo-ui/app/domain/relay";

import type { Translate } from "bmo-ui/shared/wording";

import type { Gate, LayaView } from "../../shared/gate";

// What the pages call a gate and a Laya mode, and where they reach the gate. Which gates there are, and in what
// order, is the gate's own (`GET /console/gates`), never read from here: a gate's name on screen is the key
// `gates.label.<gate>`, its hyphens as underscores, and the gate's own name where the words hold no such key, so a
// gate the words have not met yet still reads by the name it runs under.

/** Whether the words hold a key. */
export type HasKey = (key: string) => boolean;

/** The service the console relays the gate under, as the gate's manifest names it. */
export const GATE_SERVICE = "gate";

/** The path of the gate's API every call the pages make stands under, as the manifest names it. */
export const GATE_API_PREFIX = "/console";

/** The mark every gate wears on its pages. */
export const GATE_ICON = "i-material-symbols-balance";

/** The address a page calls one of the gate's screen routes at: the console's relay of the gate, then the route
 * under the API prefix. */
export function gateAddress(path: string): string {
  return relayAddress(GATE_SERVICE, `${GATE_API_PREFIX}${path}`);
}

/** The words' key for a gate's name. */
export function gateLabelKey(gate: string): string {
  return `gates.label.${gate.replaceAll("-", "_")}`;
}

export function gateLabel(t: Translate, has: HasKey, gate: string): string {
  const key = gateLabelKey(gate);

  return has(key) ? t(key) : gate;
}

/** A Laya mode as the words word it, the mode's own word where they have none. */
export function layaModeLabel(t: Translate, has: HasKey, mode: string): string {
  const key = `gates.laya_mode.${mode}`;

  return has(key) ? t(key) : mode;
}

/** How often Laya agrees with the gate's LLM, as a whole percent, or a dash where it was never compared. */
export function agreementText(agreement: number | null | undefined): string {
  return agreement === null || agreement === undefined ? "—" : `${Math.round(agreement * 100)}%`;
}

/** The text a refused call is shown as: the words' sentence for the gate's code, its hyphens as underscores, where
 * they have one, else the fallback the caller words. The app's fetcher hands the gate's own refusal, `{code, error}`,
 * as the failure's data. */
export function refusalText(t: Translate, has: HasKey, error: unknown, fallback: string): string {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  const key = typeof code === "string" ? `gates.error.${code.replaceAll("-", "_")}` : null;

  return key !== null && has(key) ? t(key) : fallback;
}

/** Where a gate stands against a turn, as the words word it, the part's own word where they have none. */
export function partLabel(t: Translate, has: HasKey, part: string): string {
  const key = `gates.part.${part}`;

  return has(key) ? t(key) : part;
}

/** One gate's Laya line: its mode and how often Laya agrees with it, or nothing where Laya is not asked on it. */
export function layaLine(t: Translate, has: HasKey, laya: LayaView | null, gate: string): string {
  const found = laya?.gates.find((one) => one.gateName === gate);

  return found === undefined ? "" : `Laya ${layaModeLabel(t, has, found.mode)} ${agreementText(found.agreement?.agreement)}`;
}

/** The gate order cut where the part changes, each run of gates under the part it stands in, in the order given. */
export function byPart(gates: readonly Gate[]): { part: string; gates: Gate[] }[] {
  const runs: { part: string; gates: Gate[] }[] = [];

  for (const gate of gates) {
    const last = runs.at(-1);

    if (last !== undefined && last.part === gate.part) last.gates.push(gate);
    else runs.push({ part: gate.part, gates: [gate] });
  }

  return runs;
}
