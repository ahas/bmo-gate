import { describe, expect, test } from "bun:test";

import { jsonArrayIn, jsonObjectsIn } from "./laya-teach";

describe("finding the list of rows in an answer", () => {
  test("a bare array is the array", () => {
    expect(jsonArrayIn('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("an array a fence is wrapped around is still the array", () => {
    expect(jsonArrayIn('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  test("a sentence in front of it does not hide it", () => {
    expect(jsonArrayIn('여기 행들입니다:\n[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test("a sentence carrying its own brackets does not stand in for it", () => {
    expect(jsonArrayIn('아래 [보기] 처럼 지었습니다:\n[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test("an answer with no array in it at all reads as nothing", () => {
    expect(jsonArrayIn("행 목록이 아니라 그냥 할 말")).toBeNull();
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
    { state: { original: "로그를 붙입니다.\n```text\nGET /healthz 502\nretry=1 upstream timed out\n```\n확인해 주세요." }, questions: {}, gold: {} },
    { state: { original: "두 번째 줄." }, questions: {}, gold: {} },
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
    const said = JSON.stringify([{ state: "[사진] 이것 좀 봐 주세요 [파일 안내문.pdf]" }, { state: "두 번째" }]);

    expect(jsonArrayIn(said)).toHaveLength(2);
  });

  test("a quote written into the text does not end the string", () => {
    const said = JSON.stringify([{ state: '그가 "그건 [보류]야" 라고 했습니다' }, { state: "두 번째" }]);

    expect(jsonArrayIn(said)).toHaveLength(2);
  });

  test("a backslash before a quote is stepped over rather than read as one", () => {
    const said = JSON.stringify([{ state: "경로는 C:\\\\temp\\\\ 입니다" }, { state: "두 번째" }]);

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
  const oneTooMany = '[{"state":"첫째","gold":{"q":{"p":1}}}},{"state":"둘째","gold":{"q":{"p":2}}}}]';

  test("the list as a whole cannot be read", () => {
    expect(jsonArrayIn(oneTooMany)).toBeNull();
  });

  test("but every row in it can", () => {
    expect(jsonObjectsIn(oneTooMany)).toHaveLength(2);
  });

  test("and the rows come through whole, not in pieces", () => {
    expect(jsonObjectsIn(oneTooMany)).toEqual([
      { state: "첫째", gold: { q: { p: 1 } } },
      { state: "둘째", gold: { q: { p: 2 } } },
    ]);
  });

  test("a nested object is not read as a row of its own", () => {
    expect(jsonObjectsIn('[{"state":"하나","gold":{"q":{"p":1}}}}]')).toEqual([{ state: "하나", gold: { q: { p: 1 } } }]);
  });

  test("prose yields no rows, so nothing is salvaged out of an answer that has none", () => {
    expect(jsonObjectsIn("행 목록이 아니라 그냥 할 말")).toBeNull();
  });

  test("a row cut off in the middle is left behind rather than guessed at", () => {
    expect(jsonObjectsIn('[{"state":"첫째","gold":{}},{"state":"둘째","gold":')).toEqual([{ state: "첫째", gold: {} }]);
  });

  test("a row whose own text carries braces is not cut short by them", () => {
    const said = '[{"state":"코드는 {\\"a\\": 1} 입니다","gold":{}}},{"state":"둘째","gold":{}}}]';

    expect(jsonObjectsIn(said)).toEqual([{ state: '코드는 {"a": 1} 입니다', gold: {} }, { state: "둘째", gold: {} }]);
  });
});
