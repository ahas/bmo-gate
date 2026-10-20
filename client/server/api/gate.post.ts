import { gateOf, refused, unreachable } from "../utils/gate";

import type { Trial } from "../../shared/gate";

interface Asked {
  gateName?: unknown;
  prompt?: unknown;
}

// The gate trial page's question: one prompt put to one gate as a turn would, kept by the gate with the signed-in
// user's name, so the page still reads what was tried after a reload. The gate refuses a gate it does not know and
// a prompt past what a turn takes.
export default defineEventHandler(async (event): Promise<Trial> => {
  const session = await requireUserSession(event);
  const asked = await readBody<Asked>(event);
  const gateName = typeof asked?.gateName === "string" ? asked.gateName : "";
  const prompt = typeof asked?.prompt === "string" ? asked.prompt.trim() : "";

  if (gateName === "") {
    throw createError({ statusCode: 400, message: "the trial names no gate", data: { code: "no-gate" } });
  }

  if (prompt === "") {
    throw createError({ statusCode: 400, message: "the trial asks nothing", data: { code: "question-empty" } });
  }

  const client = gateOf(event);

  try {
    const { data, error, response } = await client.POST("/trials", {
      body: { gateName, prompt, userName: session.user.name }
    });

    if (error !== undefined) {
      return refused(response.status, error);
    }

    return data as Trial;
  } catch (cause) {
    if (cause instanceof Error && "statusCode" in cause) {
      throw cause;
    }

    return unreachable(cause);
  }
});
