import { createHash } from "node:crypto";

import { promptFile, promptTexts } from "./prompts";

// What goes out of the rooms and what does not, when a gate's rows are built out of real
// conversation rather than invented (docs/gate-data.md, 「What leaves the rooms」).
//
// A row built from a real turn carries the people who were in the room: their display names, their
// account numbers and everything they said. The rows travel to a training node and are read by
// whoever trains on them, so the question is not whether the material is sensitive but which parts
// of it a gate actually judges by.
//
// The rule is one line: what the gate reads is kept, what merely identifies an account is replaced
// by something of the same shape. A gate reads a conversation — who is speaking, in what language,
// about what, with what standing in the room. It never reads an account number, an address or a
// key, and a row carrying one has handed a reader something the judgement did not need.

// The buckets a display name falls in, which decides the pool its stand-in is drawn from. A gate's
// language bucket is read off what was said, but a room where every name is Korean and one where
// every name is Latin do not look alike to a model reading the lines, so a name keeps its script.
export type NameScript = "hangul" | "latin";

const hangul = /[\uAC00-\uD7A3]/;

export function scriptOf(name: string): NameScript {
  return hangul.test(name) ? "hangul" : "latin";
}

// The stand-in names, one pool per script. They are ordinary names of their own language and
// nobody's in particular: a stand-in that reads as a placeholder — a numbered user — teaches the
// model that a room is full of placeholders, which is not what any room looks like. They are data the
// rows carry, so they stand in `prompts/tooling/pii.toml`.
function namePool(key: "hangul_names" | "latin_names"): readonly string[] {
  const pool = promptFile("pii")[key];

  if (!Array.isArray(pool) || pool.length === 0 || !pool.every((name) => typeof name === "string" && name !== "")) {
    throw new Error(`${key} in prompts/tooling/pii.toml is not a list of names`);
  }

  return pool as string[];
}

// The names a row keeps as they stand, because the gate's own question is about them. The chat agent's
// name is what the reply-or-not gate turns on — a row where it is replaced asks a different question than
// the gate asks — and the owner's tag is a field of the room shape, not a name the room invented.
export interface KeptNames {
  // The chat agent's own sender number, whose name stands as it speaks under it.
  agentId: number;
  // The owner's sender number. His line carries `, OWNER`, which is what the gate reads him by.
  ownerId: number;
}

export interface Pseudonyms {
  // The name this sender goes by in the rows. The chat agent's own name stands; every other is a stand-in of
  // the same script.
  nameOf(senderId: number | null, name: string): string;
  // The number this sender goes by in the rows. A real account number identifies an account and
  // nothing a gate reads, so every one of them is replaced — the owner's included, since the room
  // shape already says he is the owner.
  idOf(senderId: number | null): number | null;
}

// The stand-ins one run uses, fixed by a seed so the same room reads as the same people in every
// row of that run and in a run built again from the same seed. Two different senders never share a
// stand-in: a collision would merge two people into one and change what the room looks like.
export function pseudonyms(seed: string, kept: KeptNames): Pseudonyms {
  const names = new Map<number, string>();
  const ids = new Map<number, number>();
  const takenNames = new Set<string>();
  const takenIds = new Set<number>();

  const placeOf = (senderId: number, salt: string, over: number): number =>
    Number.parseInt(createHash("sha256").update(`${seed}:${salt}:${senderId}`).digest("hex").slice(0, 8), 16) % over;

  const nameFor = (senderId: number, real: string): string => {
    const pool = namePool(scriptOf(real) === "hangul" ? "hangul_names" : "latin_names");
    const start = placeOf(senderId, "name", pool.length);

    for (let step = 0; step < pool.length; step += 1) {
      const candidate = pool[(start + step) % pool.length]!;

      if (!takenNames.has(candidate)) {
        return candidate;
      }
    }

    // More speakers than the pool holds: the pool's name with a number after it, which is still a
    // name of the right script and still nobody's.
    return `${pool[start]!}${takenNames.size}`;
  };

  const idFor = (senderId: number): number => {
    let candidate = 1_000_000 + placeOf(senderId, "id", 9_000_000);

    while (takenIds.has(candidate)) {
      candidate += 1;
    }

    return candidate;
  };

  return {
    nameOf(senderId, name) {
      if (senderId === null) {
        return name;
      }

      if (senderId === kept.agentId) {
        return name;
      }

      const held = names.get(senderId);

      if (held !== undefined) {
        return held;
      }

      const made = nameFor(senderId, name);

      names.set(senderId, made);
      takenNames.add(made);

      return made;
    },
    idOf(senderId) {
      if (senderId === null) {
        return null;
      }

      const held = ids.get(senderId);

      if (held !== undefined) {
        return held;
      }

      const made = idFor(senderId);

      ids.set(senderId, made);
      takenIds.add(made);

      return made;
    },
  };
}

// What is taken out of a message's own text. Each of these identifies an account, a person or a
// machine outside the conversation, and none of them is what any gate judges by; each is replaced
// by a placeholder of the same shape, so a line that held an address still reads as a line that
// held an address.
// Each names its placeholder by its key in `prompts/tooling/pii.toml`.
const redactions: { what: RegExp; with: string }[] = [
  // A key, a token or a password named as one. This stands first: a secret in a training file is a
  // secret handed to everyone who ever reads the file, and no gate has ever judged by one.
  { what: /\b(?:sk|pk|ghp|gho|ghs|ghu|xox[abprs]|AIza|AKIA)[-_A-Za-z0-9]{12,}/g, with: "secret_key" },
  { what: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, with: "token" },
  { what: /\b(?:Bearer|token|apikey|api_key|password|passwd|secret)\s*[:=]\s*\S{6,}/gi, with: "secret_value" },
  // An address a message can be answered at, outside the room.
  { what: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, with: "mail" },
  { what: /\b01[016-9][-. ]?\d{3,4}[-. ]?\d{4}\b/g, with: "phone" },
  { what: /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g, with: "card" },
  { what: /\b\d{6}-[1-4]\d{6}\b/g, with: "national_number" },
  // A bank account: runs of digits joined by hyphens, the last of them three digits or more. A
  // calendar date is the same shape with a two-digit day on the end, and a date is ordinary talk
  // every room is full of, so the last run's length is what tells the two apart.
  { what: /\b\d{2,6}-\d{2,6}-\d{3,8}(?:-\d{1,6})?\b/g, with: "account" },
];

// A message's text as a row carries it. What the gate judges — the words, the code, the logs, the
// shape of the talk — stands exactly as it was said; what only names an account outside the room is
// replaced by a placeholder of its own kind.
export function scrubText(text: string): string {
  const placeholders = promptTexts("pii", "placeholders");

  return redactions.reduce((said, one) => said.replace(one.what, placeholders[one.with]!), text);
}

// Whether a text still carries anything the redactions name, which is what a test asserts and what
// a build checks a sample of its own rows with before it freezes them.
export function carriesSecret(text: string): boolean {
  return redactions.some((one) => new RegExp(one.what.source, one.what.flags.replace("g", "")).test(text));
}
