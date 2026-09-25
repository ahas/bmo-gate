import { describe, expect, test } from "bun:test";

import { layaDecide } from "./laya-service";

import type { LayaRequest } from "./laya";

const request = (count: number): LayaRequest => ({
  state: "a (id 1): 말",
  questions: Object.fromEntries(Array.from({ length: count }, (_, at) => [`q${at}`, { type: "noul", instructions: "그런가?" }])),
});

describe("layaDecide", () => {
  test("asks a request past one call in the client's parts and joins their answers", async () => {
    const asked: string[][] = [];
    const reply = await layaDecide("room-rules", request(130), "http://laya", async (_gate, part) => {
      asked.push(Object.keys(part.questions));

      return { answers: Object.fromEntries(Object.keys(part.questions).map((id) => [id, { noul: 0.9 }])) };
    });

    expect(asked.map((ids) => ids.length)).toEqual([128, 2]);
    expect(Object.keys((reply as { answers: object }).answers)).toEqual(Object.keys(request(130).questions));
  });

  test("has no answer where one part has none", async () => {
    let calls = 0;
    const reply = await layaDecide("room-rules", request(200), "http://laya", async () => {
      calls += 1;

      return calls === 1 ? { answers: {} } : null;
    });

    expect(reply).toBeNull();
  });
});
