import { askGate } from "../../utils/gate";

import type { Trial } from "../../../shared/gate";

// One gate's trials, oldest first, a page of them where `limit` names how many.
export default defineEventHandler(async (event): Promise<Trial[]> => {
  await requireUserSession(event);

  const stage = getRouterParam(event, "stage") ?? "";
  const limit = getQuery(event).limit;
  const query: Record<string, string> = typeof limit === "string" && /^\d+$/.test(limit) ? { limit } : {};
  const answer = await askGate<{ trials: Trial[] }>(event, `/trials/${encodeURIComponent(stage)}`, { query });

  return answer.trials;
});
