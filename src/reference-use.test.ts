import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pseudonyms } from "./pii";
import {
  answerCounts, attachedLabels, classifierTurn, clearingTau, contextSlug, gateFigures, goldShare, layaAnswersOf, offeredLabels,
  probeQuestion, readUseAnswer, replyAfter, trainingRows, useBatches, useItem, usePrompt, useSystem, useTurns,
} from "./reference-use";
import { sourceRoot } from "./roots";

import type { ArchivedMessage } from "./archive";
import type { LayaRequest } from "./laya";
import type { LayaAnswers, RecordedCandidate, RecordedProbe, UseReads, UseTurn } from "./reference-use";

const ownerId = 90000001;
const bmoId = 8_709_910_429;
const chatId = -1_000;
const who = { ownerId, bmoId, names: pseudonyms("test", { ownerId, bmoId }) };
const shares = { calibration: 0.15, test: 0.15 };
const asks = "이 대화에 답하려면 이 지식 문서가 필요한가?";

function message(messageId: number, senderId: number, text: string, sentAt: number): ArchivedMessage {
  return { chatId, messageId, senderId, senderName: senderId === bmoId ? "BMO" : "ahas", sentAt, text, imagePath: null, replyToMessageId: null };
}

function probe(messageId: number, slugs: readonly string[]): RecordedProbe {
  return {
    stage: "library-knowledge",
    chatId,
    messageId,
    request: {
      state: "ahas (id 90000001): 노드 GPU 몇 장이야?",
      questions: Object.fromEntries(slugs.map((slug) => [slug, { type: "noul" as const, instructions: `${asks} 문서 ${slug}: ${slug} 설명` }])),
    },
  };
}

function reads(room: ArchivedMessage[], candidates: RecordedCandidate[], probes: RecordedProbe[] = []): UseReads {
  return {
    candidates: () => candidates,
    probes: () => probes,
    room: () => room,
    fragment: (_chat, slug) => ({ line: `${slug}: 색인 한 줄`, body: `${slug} 본문` }),
  };
}

function recorded(messageId: number, slug: string, llm: boolean, attached: boolean | null): RecordedCandidate {
  return { source: "record", stage: "library-knowledge", chatId, messageId, slug, llm, attached };
}

describe("the judge's words", () => {
  test("the prompt carries every label line the document states, word for word", () => {
    const document = readFileSync(join(sourceRoot(), "docs", "reference-use.md"), "utf8");

    for (const [label, meaning] of Object.entries({ ...attachedLabels, ...offeredLabels })) {
      expect(document).toContain(`\`${label}\` — ${meaning}`);
      expect(useSystem).toContain(`- ${label}: ${meaning}`);
    }
  });
});

describe("the reply", () => {
  const room = [
    message(1, ownerId, "GPU 몇 장?", 1_000),
    message(2, 7, "나도 궁금", 1_010),
    message(3, bmoId, "네 장이에요.", 1_020),
    message(4, bmoId, "n2부터 n5까지요.", 1_021),
    message(5, ownerId, "고마워", 1_030),
    message(6, bmoId, "천만에요.", 1_040),
  ];

  test("is the first run of BMO's messages after the turn, up to somebody else's", () => {
    expect(replyAfter(room, 0, bmoId)).toBe("네 장이에요.\n\nn2부터 n5까지요.");
  });

  test("is nothing past the bound", () => {
    expect(replyAfter(room, 0, bmoId, 5)).toBeNull();
  });
});

describe("the turns", () => {
  const room = [message(10, ownerId, "노드 GPU 몇 장이야?", 2_000), message(11, bmoId, "네 장이에요.", 2_010)];

  test("carry the attached bodies, and the probe's unrecorded candidates as offered", () => {
    const built = useTurns(reads(room, [recorded(10, "compute-nodes-gpu", true, true), recorded(10, "voice", false, false)],
      [probe(10, ["compute-nodes-gpu", "voice", "pizza"])]), who);

    expect(built.turns).toHaveLength(1);

    const turn = built.turns[0]!;

    expect(turn.reply).toBe("네 장이에요.");
    expect(turn.candidates.map((one) => [one.slug, one.attached, one.body])).toEqual([
      ["compute-nodes-gpu", true, "compute-nodes-gpu 본문"],
      ["voice", false, null],
      ["pizza", false, null],
    ]);
    expect(turn.lines.join("\n")).not.toContain("ahas");
  });

  test("leave out a turn with no reply and one whose yes never said whether it attached", () => {
    const quiet = [message(10, ownerId, "노드 GPU 몇 장이야?", 2_000)];

    expect(useTurns(reads(quiet, [recorded(10, "a1", false, false)]), who).skipped.noReply).toBe(1);
    expect(useTurns(reads(room, [recorded(10, "a1", true, null)]), who).skipped.noAttachment).toBe(1);
  });

  test("show the judge no side's pick", () => {
    const turn = useTurns(reads(room, [recorded(10, "compute-nodes-gpu", true, true)]), who).turns[0]!;

    expect(JSON.stringify(useItem(turn))).not.toContain("llm");
    expect(usePrompt([turn])).toContain("library-knowledge/compute-nodes-gpu");
  });
});

function turnOf(id: string, candidates: [string, boolean, boolean, string | null][], probed = true): UseTurn {
  return {
    id,
    source: "record",
    chatId,
    messageId: 10,
    lines: ["사람1 (id 1): 노드 GPU 몇 장이야?"],
    reply: "네 장이에요.",
    candidates: candidates.map(([slug, llm, attached, label]) => ({
      gate: "library-knowledge" as const, slug, line: slug, llm, attached, body: null, bodyHash: null, label: label as never,
    })),
    probes: probed ? { "library-knowledge": [probe(10, candidates.map(([slug]) => slug)).request] } : {},
  };
}

describe("reading an answer", () => {
  test("keeps a word offered for the candidate's kind and drops any other", () => {
    const turn = turnOf("t1", [["a1", true, true, null], ["b1", false, false, null], ["c1", false, false, null]]);
    const read = readUseAnswer(JSON.stringify([{ id: "t1", labels: {
      "library-knowledge/a1": "used", "library-knowledge/b1": "used", "library-knowledge/c1": "needed",
    } }]), [turn]);

    expect([...read.get("t1")!]).toEqual([["library-knowledge/a1", "used"], ["library-knowledge/c1", "needed"]]);
  });
});

describe("the figures", () => {
  const turns = [
    turnOf("t1", [["a1", true, true, "unused"], ["b1", false, false, "not-needed"]]),
    turnOf("t2", [["a1", true, true, "used"], ["b1", false, false, "needed"]]),
    turnOf("t3", [["a1", true, true, "related"], ["b1", false, false, "not-needed"]]),
  ];
  const laya = new Map<string, LayaAnswers>([
    ["t1/library-knowledge", { a1: 0.02, b1: 0.03 }],
    ["t2/library-knowledge", { a1: 0.9, b1: 0.4 }],
    ["t3/library-knowledge", { a1: 0.3, b1: 0.01 }],
  ]);
  const figures = gateFigures("library-knowledge", turns, laya);

  test("over-selection counts unused against what attached, related beside it", () => {
    expect([figures.attached, figures.used, figures.related, figures.unused, figures.overSelection]).toEqual([3, 1, 1, 1, 0.3333]);
    expect([figures.needed, figures.missTurns]).toEqual([1, 1]);
  });

  test("the LLM and Laya are held to the gold, related standing out", () => {
    // LLM: t1 wrong (a1 unused), t2 wrong (b1 needed), t3 right once a1 stands out.
    expect([figures.llmMatchGold, figures.llmComparable]).toEqual([1, 3]);

    const all = figures.laya!.byTau.find((one) => one.tau === 0)!;
    const sure = figures.laya!.byTau.find((one) => one.tau === 0.9)!;

    // Laya: t1 and t3 match the gold, t2 misses b1; it picks the LLM's set on t2 alone.
    expect([all.settled, all.matchGold, all.matchLlm]).toEqual([3, 2, 1]);
    expect([sure.settled, sure.matchGold, sure.accuracyGold]).toEqual([1, 1, 1]);
    expect(clearingTau(figures, 0.98)).toBeNull();
  });
});

describe("the training rows", () => {
  test("carry the turn's own questions with a gold out of each label", () => {
    const outcome = trainingRows("library-knowledge", [
      turnOf("t1", [["a1", true, true, "used"], ["b1", false, false, "not-needed"], ["c1", false, false, "needed"]]),
      turnOf("t2", [["a1", true, true, "related"], ["b1", false, false, null]]),
      turnOf("t3", [["a1", true, true, "used"]], false),
    ], shares);

    expect(outcome.refusals).toEqual({ unlabelled: 1, "no-probe": 1 });
    expect(outcome.rows).toHaveLength(1);

    const gold = JSON.parse(outcome.rows[0]!.row.gold) as Record<string, { label: string; noul: number }>;

    expect([gold.a1!.label, gold.b1!.label, gold.c1!.noul]).toEqual(["true", "false", 0.95]);
    expect(outcome.rows[0]!.row.id.startsWith("library-knowledge:")).toBe(true);
    expect(outcome.rows[0]!.language).toBe("korean");
    expect(goldShare("related")).toBe(0.5);
  });

  test("cut a person-book turn's probe inputs into rows of at most the gate's twenty, read together", () => {
    const slugs = Array.from({ length: 45 }, (_, at) => `p${at}`);
    const ask = (taken: readonly string[]): LayaRequest => ({
      state: "사람1 (id 1): 걔 생일 언제였지?",
      questions: Object.fromEntries(taken.map((slug) => [slug, probeQuestion("people-search", slug, `${slug} 기록`)])),
    });
    const turn: UseTurn = {
      ...turnOf("t1", []),
      candidates: slugs.map((slug, at) => ({
        gate: "people-search" as const, slug, line: slug, llm: at === 0, attached: at === 0, body: null, bodyHash: null,
        label: at === 0 ? "used" as const : "not-needed" as const,
      })),
      probes: { "people-search": [ask(slugs.slice(0, 30)), ask(slugs.slice(30))] },
    };
    const outcome = trainingRows("people-search", [turn], shares);

    expect(outcome.rows.map((one) => Object.keys(JSON.parse(one.row.questions) as object).length)).toEqual([20, 10, 15]);
    expect(answerCounts(outcome.rows.map((one) => one.row))).toEqual({ rows: 3, rowsWithYes: 1, yes: 1, no: 44, contested: 0 });
  });
});

describe("turns read out of the agent log", () => {
  const prompt = [
    "INDEX:",
    "# System reference index",
    "",
    "- This is the index of the system's own reference documents.",
    "",
    "## The system",
    "",
    "- structure — what a chat provider and a gate are",
    "- wording — how Korean text spells loanwords",
    "",
    "# Room rules — 90000001",
    "",
    "- infra-work-procedure — infra, server, docs · 2026-09",
    "",
    "# Knowledge index",
    "",
    "- compute-nodes-gpu [chat:90000001] — compute nodes, GPU · 2026-09",
    "",
    "MESSAGES:",
    "ahas (id 90000001): 노드 GPU 몇 장이야?",
  ].join("\n");
  const run = { chatId, messageId: 10, prompt, whole: true, answer: "compute-nodes-gpu,infra-work-procedure" };

  test("a whole run is every heading's candidates, the pick as the LLM's yes and the context line as attached", () => {
    const turn = classifierTurn(run, new Set(["compute-nodes-gpu", "sheet"]));

    if (typeof turn === "string") {
      throw new Error(turn);
    }

    expect(turn.candidates.map((one) => [one.source, one.stage, one.slug, one.llm, one.attached])).toEqual([
      ["log", "system-documents", "structure", false, false],
      ["log", "system-documents", "wording", false, false],
      ["log", "room-rules", "infra-work-procedure", true, false],
      ["log", "library-knowledge", "compute-nodes-gpu", true, true],
    ]);
    expect(turn.probes.map((one) => one.stage)).toEqual(["system-documents", "room-rules", "library-knowledge"]);
    expect(turn.probes[2]!.request).toEqual({
      state: "ahas (id 90000001): 노드 GPU 몇 장이야?",
      questions: {
        "compute-nodes-gpu": { type: "noul", instructions: "이 대화에 답하려면 이 지식 문서가 필요한가? 문서 compute-nodes-gpu: compute nodes, GPU · 2026-09" },
      },
    });
  });

  test("a cut prompt, a failed answer and a turn no run says the attachments of are no turn", () => {
    expect(classifierTurn({ ...run, whole: false }, new Set())).toBe("cut");
    expect(classifierTurn({ ...run, answer: "no answer (timeout)" }, new Set())).toBe("failed");
    expect(classifierTurn({ ...run, answer: "pizza" }, new Set())).toBe("failed");
    expect(classifierTurn(run, null)).toBe("noContext");
    expect(classifierTurn({ ...run, answer: "none" }, new Set())).not.toBeTypeOf("string");
  });

  test("a context line names its piece by the last part of its path", () => {
    expect(contextSlug("STRUCTURE.md")).toBe("structure");
    expect(contextSlug("/home/x/brain/rooms/-1/rules/parts-quote.md")).toBe("parts-quote");
  });
});

describe("Laya's answers", () => {
  test("are read per slug as the probability of yes", () => {
    expect(layaAnswersOf("library-knowledge", { answers: { a1: { type: "noul", noul: 0.7, confidence: 0.7 } } })).toEqual({ a1: 0.7 });
    expect(layaAnswersOf("library-knowledge", { error: "no" })).toBeNull();
  });
});

describe("the batches", () => {
  test("hold at most the turn bound and always one turn", () => {
    const turns = Array.from({ length: 5 }, (_, at) => turnOf(`t${at}`, [["a1", true, true, null]]));

    expect(useBatches(turns, 2).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(useBatches(turns, 8, 1).map((batch) => batch.length)).toEqual([1, 1, 1, 1, 1]);
  });
});
