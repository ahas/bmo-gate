import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "../scratch";
import { labelKey, readLabels } from "./labels";
import { gateDataFile, gatesFolder, labelsFile, referenceTick } from "./tick";

import type { JudgeRoad } from "../gate-judge";
import type { InputsAsk, LiveTurn } from "./live-inputs";
import type { ReferenceTurn } from "./turns";
import type { TickOptions } from "./tick";

const root = scratchDir("bmo-reference-tick-");
let made = 0;

function folder(): string {
  made += 1;
  const where = join(root, `case-${made}`);

  mkdirSync(where, { recursive: true });

  return where;
}

const turns: ReferenceTurn[] = [3, 2, 1].map((id) => ({
  key: `-7:${id}`, chatId: -7, messageIds: [id], at: id, source: "run", attached: new Set(["quiet"]), reply: `답 ${id}`, recorded: [],
}));

// BMO's inputs: every turn offers the room's two rules, and what BMO has to say of each is the same.
function inputs(asked: InputsAsk[][]): (asks: readonly InputsAsk[]) => LiveTurn[] {
  return (asks) => {
    asked.push([...asks]);

    return asks.map((ask) => ({
      chatId: ask.chatId,
      messageIds: ask.messageIds,
      missing: false,
      gates: [{
        gate: "room-rules", held: 2, capped: 0,
        candidates: [{ slug: "quiet", about: "밤에는 조용히" }, { slug: "photos", about: "사진" }],
        request: {
          state: `사람 (id 51078230): 말 ${ask.messageIds[0]}`,
          questions: {
            quiet: { type: "noul", instructions: "이 대화에 답하려면 이 방 규칙이 필요한가? 규칙 quiet: 밤에는 조용히" },
            photos: { type: "noul", instructions: "이 대화에 답하려면 이 방 규칙이 필요한가? 규칙 photos: 사진" },
          },
        },
      }],
      pieces: (ask.bodies?.["room-rules"] ?? []).map((slug) => ({ gate: "room-rules" as const, slug, about: "밤에는 조용히", body: "# 조용히" })),
    }));
  };
}

// A judge that answers every piece it is shown: the attached one used, the others not needed.
const judge: JudgeRoad = async (_system, prompt) => {
  const items = prompt.split("\n").slice(1).map((line) => JSON.parse(line) as { id: string; attached: { key: string }[]; offered: { key: string }[] });

  return {
    text: JSON.stringify(items.map((item) => ({
      id: item.id,
      labels: Object.fromEntries([...item.attached.map((one) => [one.key, "used"]), ...item.offered.map((one) => [one.key, "not-needed"])]),
    }))),
    sessionId: null,
    tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
};

function options(where: string, asked: InputsAsk[][], changes: Partial<TickOptions> = {}): TickOptions {
  return {
    root: where,
    built: { turns, skipped: { noReply: 0, noMessage: 0, noText: 0 } },
    inputs: inputs(asked),
    road: judge,
    judged: 2,
    atOnce: 1,
    messages: (turn) => [`사람 (id 1): 말 ${turn.messageIds[0]}`],
    leaveText: (text) => text,
    leaveRequest: (request) => request,
    laya: null,
    bmoCommit: "abc1234",
    archive: { takenAt: "2026-09-25T00:00:00.000Z", schemaVersion: 7 },
    importFrom: null,
    now: () => new Date("2026-09-25T00:00:00Z"),
    ...changes,
  };
}

describe("referenceTick", () => {
  test("judges the newest turns within its bound, and makes a row only of a turn whose every candidate has a label", async () => {
    const where = folder();
    const asked: InputsAsk[][] = [];
    const report = await referenceTick(options(where, asked));
    const data = JSON.parse(readFileSync(join(where, gatesFolder, "room-rules", gateDataFile), "utf8")) as { rows: { train: number; calibration: number; test: number }; waiting: number; yes: number };

    expect(report.judgedTurns).toBe(2);
    expect(asked[1]!.map((ask) => ask.messageIds[0])).toEqual([3, 2]);
    expect(asked[1]![0]!.bodies!["room-rules"]).toEqual(["quiet"]);
    expect(readLabels(join(where, labelsFile)).get(labelKey("-7:3", "room-rules", "quiet"))!.word).toBe("used");
    expect(data.rows.train + data.rows.calibration + data.rows.test).toBe(2);
    expect([data.waiting, data.yes]).toEqual([1, 2]);
    expect(report.bmo).toBe("abc1234");
    expect(JSON.parse(readFileSync(join(where, "ticks.jsonl"), "utf8")).archive).toEqual({ takenAt: "2026-09-25T00:00:00.000Z", schemaVersion: 7 });
  });

  test("the next pass judges only what is still missing, and puts the gates in place whole", async () => {
    const where = folder();

    await referenceTick(options(where, []));

    const asked: InputsAsk[][] = [];
    const report = await referenceTick(options(where, asked));

    expect(report.judgedTurns).toBe(1);
    expect(asked[1]!.map((ask) => ask.messageIds[0])).toEqual([1]);
    expect(existsSync(join(where, `${gatesFolder}.partial`))).toBe(false);
    expect(existsSync(join(where, `${gatesFolder}.old`))).toBe(false);
    expect(report.gates.find((one) => one.gate === "room-rules")!.waiting).toBe(0);
  });

  test("a failed batch ends the judging, and the batches after it are never sent", async () => {
    let sent = 0;
    const spent: JudgeRoad = async () => {
      sent += 1;
      throw new Error("You've hit your limit");
    };
    // Twenty turns are three batches of at most eight.
    const many: ReferenceTurn[] = Array.from({ length: 20 }, (_, index) => ({ ...turns[0]!, key: `-7:${index + 10}`, messageIds: [index + 10] }));
    const report = await referenceTick(options(folder(), [], {
      road: spent, judged: 20, built: { turns: many, skipped: { noReply: 0, noMessage: 0, noText: 0 } },
    }));

    expect([sent, report.calls, report.failedBatches]).toEqual([1, 0, 1]);
  });

  test("takes the first judging's labels in once, where the run has none", async () => {
    const where = folder();
    const first = join(where, "use-turns.jsonl");

    writeFileSync(first, `${JSON.stringify({ id: "-7:3", candidates: [{ gate: "room-rules", slug: "quiet", attached: true, label: "unused" }] })}\n`);

    const report = await referenceTick(options(where, [], { importFrom: first, road: null }));

    expect(report.imported).toBe(1);
    expect(report.figures.find((one) => one.gate === "room-rules")!.unused).toBe(1);
  });

  test("asks Laya again only where the checkpoint or the input moved", async () => {
    const where = folder();
    let calls = 0;
    const laya = { served: new Map([["room-rules", "checkpoints/room-rules/r/step-000001"]]), ask: async () => { calls += 1; return { quiet: 0.9, photos: 0.1 }; } };

    await referenceTick(options(where, [], { laya }));
    const again = await referenceTick(options(where, [], { laya, road: null }));

    expect(calls).toBe(3);
    expect([again.layaAsked, again.layaReused]).toEqual([0, 3]);
  });
});
