// A service's adapter for the card master (the arbiter's docs/placement.md, 「An adapter's verbs」): the verb, the node
// and the placed nodes read off the command line, and the one answer every verb ends with, written as the
// last line of the adapter's output. What a verb does is the service's own; this is only the shape.

export const ADAPTER_VERBS = ["install", "uninstall", "start", "stop", "health", "placed"] as const;

export type AdapterVerb = (typeof ADAPTER_VERBS)[number];

export type ServiceState = "running" | "stopped" | "absent" | "failing";

/** What every verb answers. */
export interface AdapterAnswer {
  ok: boolean;
  node: string | null;
  state: ServiceState | null;
  detail: string;
  /** The nodes the service's own placement names, in order; `placed` alone gives them. */
  nodes?: string[];
}

/** What the master asks: the verb, the node it is about, and the service's nodes in order once it is done. */
export interface AdapterAsk {
  verb: AdapterVerb;
  node: string | null;
  placed: string[];
}

/** The ask out of the adapter's own words, or why they are not one. */
export function readAsk(argv: readonly string[]): AdapterAsk | string {
  const [verb, ...rest] = argv;
  if (!ADAPTER_VERBS.includes(verb as AdapterVerb)) {
    return `an adapter's verb is one of ${ADAPTER_VERBS.join(", ")} — ${verb ?? "(none)"}`;
  }
  let node: string | null = null;
  let placed: string[] = [];
  for (let at = 0; at < rest.length; at += 2) {
    const value = rest[at + 1];
    if (value === undefined) {
      return `${rest[at]} has no value`;
    }
    if (rest[at] === "--node") {
      node = value;
    } else if (rest[at] === "--placed") {
      placed = value.split(",").filter((one) => one !== "");
    } else {
      return `${rest[at]} is not an option the adapter knows`;
    }
  }
  if (verb !== "placed" && node === null) {
    return `${verb} needs --node`;
  }
  return { verb: verb as AdapterVerb, node, placed };
}

/** The answer as the adapter's last line. */
export function answerLine(answer: AdapterAnswer): string {
  return JSON.stringify(answer);
}

export function refused(node: string | null, detail: string): AdapterAnswer {
  return { ok: false, node, state: null, detail };
}

/** An adapter run whole: the ask read, the service's own work done, and the answer written last; anything
 * the work throws is an answer that it failed. */
export async function runAdapter(argv: readonly string[], work: (ask: AdapterAsk) => Promise<AdapterAnswer>): Promise<number> {
  const ask = readAsk(argv);
  let answer: AdapterAnswer;
  if (typeof ask === "string") {
    answer = refused(null, ask);
  } else {
    try {
      answer = await work(ask);
    } catch (fault) {
      answer = refused(ask.node, fault instanceof Error ? fault.message : String(fault));
    }
  }
  console.log(answerLine(answer));
  return answer.ok ? 0 : 1;
}
