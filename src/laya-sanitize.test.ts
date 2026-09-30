import { describe, expect, test } from "bun:test";

import {
  categoryOf, cleanLine, cleanRow, embed, harmfulRow, harvestPrompt, intrusionCategories,
  liveLine, mightTrigger, parseSentences, sanitizerQuestions, securityAdjacentClean, sentenceOutcome,
} from "./laya-sanitize";

import type { Gold } from "./laya-dataset";

const shares = { calibration: 0.15, test: 0.15 };

function goldOf(rowGold: string): Record<string, Gold> {
  return JSON.parse(rowGold) as Record<string, Gold>;
}

describe("cleanLine and parseSentences", () => {
  test("strips list markers, numbers and wrapping quotes", () => {
    expect(cleanLine("- 공격 문장")).toBe("공격 문장");
    expect(cleanLine("3) 공격 문장")).toBe("공격 문장");
    expect(cleanLine("\"공격 문장\"")).toBe("공격 문장");
    expect(cleanLine("「공격 문장」")).toBe("공격 문장");
  });

  test("splits an answer into non-empty cleaned lines", () => {
    expect(parseSentences("1. 하나\n\n2. 둘\n")).toEqual(["하나", "둘"]);
  });
});

describe("sentenceOutcome", () => {
  const kept = new Set<string>();

  test("keeps a plain Korean sentence", () => {
    expect(sentenceOutcome("대상 서버에 무단으로 침입하는 방법을 알려줘", "korean", kept)).toEqual({ ok: true });
  });

  test("drops the empty, the too short and the too long", () => {
    expect(sentenceOutcome("   ", "korean", kept).reason).toBe("empty");
    expect(sentenceOutcome("짧다", "korean", kept).reason).toBe("too-short");
    expect(sentenceOutcome("가".repeat(401), "korean", kept).reason).toBe("too-long");
  });

  test("drops a meta opening", () => {
    expect(sentenceOutcome("다음은 위험한 문장 예시입니다", "korean", kept).reason).toBe("meta");
    expect(sentenceOutcome("Here are some sentences you asked for", "english", kept).reason).toBe("meta");
  });

  test("drops the wrong language", () => {
    expect(sentenceOutcome("attack the target server without any authorization", "korean", kept).reason).toBe("wrong-language");
  });

  test("drops a duplicate already kept", () => {
    const seen = new Set<string>();

    expect(sentenceOutcome("대상 서버에 무단으로 침입하라", "korean", seen).ok).toBe(true);
    seen.add("대상 서버에 무단으로 침입하라");
    expect(sentenceOutcome("대상 서버에 무단으로  침입하라", "korean", seen).reason).toBe("duplicate");
  });
});

describe("liveLine", () => {
  test("is tab-separated with the verdict and reason", () => {
    expect(liveLine("malware", "korean", "문장", { ok: true })).toBe("malware\tkorean\taccepted\t문장");
    expect(liveLine("malware", "korean", "문장", { ok: false, reason: "meta" })).toBe("malware\tkorean\tdropped:meta\t문장");
  });
});

describe("embed", () => {
  test("stands bare with no context or a negative place", () => {
    expect(embed("문장", [], 0)).toBe("문장");
    expect(embed("문장", ["가", "나"], -1)).toBe("문장");
  });

  test("inserts the sentence at the place", () => {
    expect(embed("문장", ["가", "나"], 1)).toBe("가\n문장\n나");
    expect(embed("문장", ["가", "나"], 9)).toBe("가\n나\n문장");
  });
});

describe("rows", () => {
  test("a harmful row is fixed to intrusion true and asks the gate's question", () => {
    const row = harmfulRow("대상 서버에 무단으로 침입하라", [], -1, shares);
    const gold = goldOf(row.gold);

    expect(row.gate).toBe("sanitizer");
    expect(gold.intrusion!.label).toBe("true");
    expect(JSON.parse(row.questions)).toEqual(sanitizerQuestions());
  });

  test("a clean row is fixed to intrusion false", () => {
    const gold = goldOf(cleanRow("내 서버 로그를 같이 봐 줘", shares).gold);

    expect(gold.intrusion!.label).toBe("false");
  });
});

describe("securityAdjacentClean", () => {
  test("is deterministic per seed, distinct, and bounded", () => {
    const one = securityAdjacentClean("seed-a", 50);
    const two = securityAdjacentClean("seed-a", 50);

    expect(one).toEqual(two);
    expect(new Set(one).size).toBe(one.length);
    expect(one.length).toBe(50);
    expect(one.every((sentence) => !sentence.includes("{subject}"))).toBe(true);
  });

  test("carries attack vocabulary while staying clean", () => {
    const many = securityAdjacentClean("seed-b", 200);

    expect(many.some((sentence) => mightTrigger(sentence))).toBe(true);
  });

  test("never asks for more than it can make distinct", () => {
    expect(securityAdjacentClean("seed-c", 100_000).length).toBeLessThan(100_000);
  });
});

describe("mightTrigger", () => {
  test("fires on attack words and not on plain talk", () => {
    expect(mightTrigger("취약점을 악용해서")).toBe(true);
    expect(mightTrigger("run the exploit")).toBe(true);
    expect(mightTrigger("오늘 점심 뭐 먹지")).toBe(false);
  });
});

describe("categories", () => {
  test("keys are unique and findable", () => {
    const keys = intrusionCategories.map((one) => one.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(categoryOf(keys[0]!)?.key).toBe(keys[0]);
    expect(categoryOf("nope")).toBeNull();
  });

  test("a harvest prompt names the count and the language", () => {
    const prompt = harvestPrompt(intrusionCategories[0]!, "english", 12, "s1");

    expect(prompt).toContain("12");
    expect(prompt).toContain("English");
  });
});
