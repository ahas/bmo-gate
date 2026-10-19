import { describe, expect, test } from "bun:test";

import { jsonArrayIn, jsonObjectsIn } from "../../training/tooling/src/laya-teach";
import { useToolingSettings } from "./settings";

useToolingSettings();

describe("finding the list of rows in an answer", () => {
  test("a bare array is the array", () => {
    expect(jsonArrayIn('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("an array a fence is wrapped around is still the array", () => {
    expect(jsonArrayIn('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  test("a sentence in front of it does not hide it", () => {
    expect(jsonArrayIn('\uC5EC\uAE30 \uD589\uB4E4\uC785\uB2C8\uB2E4:\n[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test("a sentence carrying its own brackets does not stand in for it", () => {
    expect(jsonArrayIn('\uC544\uB798 [\uBCF4\uAE30] \uCC98\uB7FC \uC9C0\uC5C8\uC2B5\uB2C8\uB2E4:\n[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test("an answer with no array in it at all reads as nothing", () => {
    expect(jsonArrayIn("\uD589 \uBAA9\uB85D\uC774 \uC544\uB2C8\uB77C \uADF8\uB0E5 \uD560 \uB9D0")).toBeNull();
  });

  test("something that is not a list is not a list", () => {
    expect(jsonArrayIn('{"a":1}')).toBeNull();
  });
});

describe("an answer whose own content carries a code fence", () => {
  // The gate that judges an answer's formatting is handed the markdown it was converted from, so
  // its rows carry fenced blocks as a matter of course. A reader that unwraps a fence before
  // looking for the array reads one of those blocks as the answer and throws the batch away.
  const withFence = JSON.stringify([
    { state: { original: "\uB85C\uADF8\uB97C \uBD99\uC785\uB2C8\uB2E4.\n```text\nGET /healthz 502\nretry=1 upstream timed out\n```\n\uD655\uC778\uD574 \uC8FC\uC138\uC694." }, questions: {}, gold: {} },
    { state: { original: "\uB450 \uBC88\uC9F8 \uC904." }, questions: {}, gold: {} },
  ]);

  test("is read as the array it is, not as the block inside it", () => {
    expect(jsonArrayIn(withFence)).toHaveLength(2);
  });

  test("the row's own fenced block comes through untouched", () => {
    const rows = jsonArrayIn(withFence) as { state: { original: string } }[];

    expect(rows[0]!.state.original).toContain("```text");
    expect(rows[0]!.state.original).toContain("GET /healthz 502");
  });

  test("a fence around the answer still works when the rows carry fences too", () => {
    expect(jsonArrayIn(`\`\`\`json\n${withFence}\n\`\`\``)).toHaveLength(2);
  });
});

describe("an answer whose content carries brackets", () => {
  test("a bracket inside a row's text does not end the list early", () => {
    const said = JSON.stringify([{ state: "[\uC0AC\uC9C4] \uC774\uAC83 \uC880 \uBD10 \uC8FC\uC138\uC694 [\uD30C\uC77C \uC548\uB0B4\uBB38.pdf]" }, { state: "\uB450 \uBC88\uC9F8" }]);

    expect(jsonArrayIn(said)).toHaveLength(2);
  });

  test("a quote written into the text does not end the string", () => {
    const said = JSON.stringify([{ state: '\uADF8\uAC00 "\uADF8\uAC74 [\uBCF4\uB958]\uC57C" \uB77C\uACE0 \uD588\uC2B5\uB2C8\uB2E4' }, { state: "\uB450 \uBC88\uC9F8" }]);

    expect(jsonArrayIn(said)).toHaveLength(2);
  });

  test("a backslash before a quote is stepped over rather than read as one", () => {
    const said = JSON.stringify([{ state: "\uACBD\uB85C\uB294 C:\\\\temp\\\\ \uC785\uB2C8\uB2E4" }, { state: "\uB450 \uBC88\uC9F8" }]);

    expect(jsonArrayIn(said)).toHaveLength(2);
  });
});

describe("an answer that is not whole", () => {
  test("a list cut off in the middle is not a list", () => {
    expect(jsonArrayIn('[{"a":1},{"a":')).toBeNull();
  });

  test("a list closed by the wrong bracket is refused rather than read as far as it goes", () => {
    // A model writing one `}` too many after every row ends its list this way. The text begins
    // with `[` and ends with `]`, so it reads whole at a glance and is not.
    expect(jsonArrayIn('[{"a":{"b":1}}},{"a":{"b":2}}}]')).toBeNull();
  });

  test("two lists standing next to each other are not one list", () => {
    expect(jsonArrayIn('[{"a":1}][{"a":2}]')).toEqual([{ a: 1 }]);
  });
});

describe("reading the rows out of a list that is not whole", () => {
  // What a model writing long, deeply nested rows does: the row itself closes correctly and then
  // one brace too many follows it, so the list breaks around rows that are perfectly good.
  const oneTooMany = '[{"state":"\uCCAB\uC9F8","gold":{"q":{"p":1}}}},{"state":"\uB458\uC9F8","gold":{"q":{"p":2}}}}]';

  test("the list as a whole cannot be read", () => {
    expect(jsonArrayIn(oneTooMany)).toBeNull();
  });

  test("but every row in it can", () => {
    expect(jsonObjectsIn(oneTooMany)).toHaveLength(2);
  });

  test("and the rows come through whole, not in pieces", () => {
    expect(jsonObjectsIn(oneTooMany)).toEqual([
      { state: "\uCCAB\uC9F8", gold: { q: { p: 1 } } },
      { state: "\uB458\uC9F8", gold: { q: { p: 2 } } },
    ]);
  });

  test("a nested object is not read as a row of its own", () => {
    expect(jsonObjectsIn('[{"state":"\uD558\uB098","gold":{"q":{"p":1}}}}]')).toEqual([{ state: "\uD558\uB098", gold: { q: { p: 1 } } }]);
  });

  test("prose yields no rows, so nothing is salvaged out of an answer that has none", () => {
    expect(jsonObjectsIn("\uD589 \uBAA9\uB85D\uC774 \uC544\uB2C8\uB77C \uADF8\uB0E5 \uD560 \uB9D0")).toBeNull();
  });

  test("a row cut off in the middle is left behind rather than guessed at", () => {
    expect(jsonObjectsIn('[{"state":"\uCCAB\uC9F8","gold":{}},{"state":"\uB458\uC9F8","gold":')).toEqual([{ state: "\uCCAB\uC9F8", gold: {} }]);
  });

  test("a row whose own text carries braces is not cut short by them", () => {
    const said = '[{"state":"\uCF54\uB4DC\uB294 {\\"a\\": 1} \uC785\uB2C8\uB2E4","gold":{}}},{"state":"\uB458\uC9F8","gold":{}}}]';

    expect(jsonObjectsIn(said)).toEqual([{ state: '\uCF54\uB4DC\uB294 {"a": 1} \uC785\uB2C8\uB2E4', gold: {} }, { state: "\uB458\uC9F8", gold: {} }]);
  });
});
