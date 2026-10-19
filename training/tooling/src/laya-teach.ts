// Reading a list of rows out of what a model answered. The answer is prose as often as not — a
// fence around the list, a sentence before it — so the array is found inside the text rather than
// the whole text being handed to the parser.
//
// The array is found by walking the brackets rather than by taking everything between the first
// `[` and the last `]`. Rows carry whatever the gate really receives, and what a gate receives
// includes code fences, log excerpts and text full of brackets; a reader that slices on the
// outermost brackets it can see reads the data as though it were the answer's own punctuation and
// throws away a batch that was perfectly good.

export function jsonArrayIn(answer: string): unknown[] | null {
  // The text as it stands first. A fence is only worth unwrapping where the answer is not
  // readable without doing so — unwrapped first, a fence standing inside a row's own content
  // would be taken for the fence around the answer.
  return arrayIn(answer) ?? arrayIn(fencedIn(answer));
}

// The objects in a text, read one at a time, for an answer whose list is not whole. A model
// writing a long row of deeply nested parts miscounts the braces that close it and leaves the
// list broken around rows that are themselves perfectly good — and the rows are what was asked
// for, not the punctuation between them. Each object still has to stand on its own and parse, so
// prose yields none of them and a row cut off in the middle is left behind rather than guessed at.
export function jsonObjectsIn(text: string): unknown[] | null {
  const found: unknown[] = [];

  for (let at = text.indexOf("{"); at >= 0; at = text.indexOf("{", at + 1)) {
    const closed = closesAt(text, at);

    if (closed < 0) {
      continue;
    }

    try {
      found.push(JSON.parse(text.slice(at, closed + 1)) as unknown);
      at = closed;
    } catch {
      // Not an object, whatever its brackets did. The next one is tried.
    }
  }

  return found.length === 0 ? null : found;
}

function fencedIn(answer: string): string {
  return /```(?:json)?\s*([\s\S]*?)```/.exec(answer)?.[1] ?? "";
}

// The first array in the text that is whole and reads as a list. Every `[` is tried in turn,
// because the first one may belong to a sentence in front of the answer rather than to the answer.
function arrayIn(text: string): unknown[] | null {
  for (let start = text.indexOf("["); start >= 0; start = text.indexOf("[", start + 1)) {
    const closed = closesAt(text, start);

    if (closed < 0) {
      continue;
    }

    try {
      const value = JSON.parse(text.slice(start, closed + 1)) as unknown;

      if (Array.isArray(value)) {
        return value;
      }
    } catch {
      // Not this one. Whatever stands at this bracket is not the list of rows.
    }
  }

  return null;
}

// Where the bracket opened at `from` closes, or -1 where it never does or is closed by a bracket
// of the wrong kind. Quoting is followed, so a bracket inside a row's text counts for nothing, and
// an escape is stepped over so a quote written into the text does not read as the end of it.
function closesAt(text: string, from: number): number {
  const shuts = text[from] === "[" ? "]" : "}";
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let at = from; at < text.length; at += 1) {
    const letter = text[at]!;

    if (escaped) {
      escaped = false;

      continue;
    }

    if (quoted && letter === "\\") {
      escaped = true;

      continue;
    }

    if (letter === '"') {
      quoted = !quoted;

      continue;
    }

    if (quoted) {
      continue;
    }

    if (letter === "[" || letter === "{") {
      depth += 1;

      continue;
    }

    if (letter === "]" || letter === "}") {
      depth -= 1;

      if (depth === 0) {
        // Closed by the wrong kind of bracket: the text is not whole, whatever it looks like at
        // its two ends. A model writing one `}` too many after every row ends its list this way.
        return letter === shuts ? at : -1;
      }

      if (depth < 0) {
        return -1;
      }
    }
  }

  return -1;
}
