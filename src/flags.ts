// Reading a command's own words. Small on purpose: a flag takes a value or it does not, a flag
// may be given more than once, and anything the command does not know about is said back rather
// than passed over, because a misspelt flag that is quietly ignored is a run doing something
// other than what it was asked for.

export interface Reading {
  ok: boolean;
  // Every value given for a flag, in the order they were given.
  given: Record<string, string[]>;
  // What stood on the line without a flag in front of it.
  loose: string[];
  trouble: string | null;
}

export function readFlags(argv: readonly string[], takes: Record<string, boolean>): Reading {
  const given: Record<string, string[]> = {};
  const loose: string[] = [];

  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at]!;

    if (!word.startsWith("--")) {
      loose.push(word);

      continue;
    }

    if (!(word in takes)) {
      return { ok: false, given, loose, trouble: `${word} 는 이 명령이 아는 옵션이 아닙니다.` };
    }

    (given[word] ??= []);

    if (!takes[word]) {
      given[word]!.push("");

      continue;
    }

    const value = argv[at + 1];

    if (value === undefined || value.startsWith("--")) {
      return { ok: false, given, loose, trouble: `${word} 에는 값이 있어야 합니다.` };
    }

    given[word]!.push(value);
    at += 1;
  }

  return { ok: true, given, loose, trouble: null };
}

export function asksUsage(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

// The last value given for a flag wins, so a wrapper can set a default and the line can override
// it without the wrapper having to know.
export function lastOf(reading: Reading, flag: string): string | undefined {
  return reading.given[flag]?.at(-1);
}

export function allOf(reading: Reading, flag: string): string[] {
  return reading.given[flag] ?? [];
}

export function asked(reading: Reading, flag: string): boolean {
  return flag in reading.given;
}
