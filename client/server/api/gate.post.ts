import { askGate } from "../utils/gate";

import type { Trial } from "../../shared/gate";

interface Asked {
  stage?: unknown;
  prompt?: unknown;
}

// The gate trial page's question: one prompt put to one gate as a turn would, kept by the gate with the signed-in
// user's name, so the page still reads what was tried after a reload. The gate refuses a gate it does not know and
// a prompt past what a turn takes.
export default defineEventHandler(async (event): Promise<Trial> => {
  const session = await requireUserSession(event);
  const asked = await readBody<Asked>(event);
  const stage = typeof asked?.stage === "string" ? asked.stage : "";
  const prompt = typeof asked?.prompt === "string" ? asked.prompt.trim() : "";

  if (stage === "") {
    throw createError({ statusCode: 400, message: "the trial names no gate", data: { code: "no_gate" } });
  }

  if (prompt === "") {
    throw createError({ statusCode: 400, message: "the trial asks nothing", data: { code: "question_empty" } });
  }

  return askGate<Trial>(event, "/trials", { method: "POST", body: { stage, prompt, user: session.user.name } });
});
