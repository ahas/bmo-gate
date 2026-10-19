import type { Translate } from "bmo-ui/shared/wording";

// What the page calls a gate and a Laya mode. Which gates there are, and in what order, is the gate's own
// (`GET /gates`), never read from here: a gate's name on screen is the key `gates.label.<gate>`, its hyphens as
// underscores, and the gate's own name where the host's pack holds no such key, so a gate the pack has not met yet
// still reads by the name it runs under.

/** Whether the host's pack holds a key. */
export type HasKey = (key: string) => boolean;

/** The mark every gate wears on its page. */
export const GATE_ICON = "i-material-symbols-balance";

/** The pack's key for a gate's name. */
export function gateLabelKey(gate: string): string {
  return `gates.label.${gate.replaceAll("-", "_")}`;
}

export function gateLabel(t: Translate, has: HasKey, gate: string): string {
  const key = gateLabelKey(gate);

  return has(key) ? t(key) : gate;
}

/** A Laya mode as the pack words it, the mode's own word where the pack has none. */
export function layaModeLabel(t: Translate, has: HasKey, mode: string): string {
  const key = `gates.laya_mode.${mode}`;

  return has(key) ? t(key) : mode;
}

/** How often Laya agrees with the gate's LLM, as a whole percent, or a dash where it was never compared. */
export function agreementText(agreement: number | null | undefined): string {
  return agreement === null || agreement === undefined ? "—" : `${Math.round(agreement * 100)}%`;
}

/** The text a refused call is shown as: the pack's sentence for the gate's code where it has one, else the
 * fallback the caller words. */
export function refusalText(t: Translate, has: HasKey, error: unknown, fallback: string): string {
  const code = (error as { data?: { data?: { code?: unknown } } } | null)?.data?.data?.code;
  const key = typeof code === "string" ? `gates.error.${code}` : null;

  return key !== null && has(key) ? t(key) : fallback;
}
