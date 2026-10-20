import { gateOf, refused, unreachable } from "../../utils/gate";

import type { Trial } from "../../../shared/gate";

// One gate's trials, oldest first, a page of them where `limit` names how many.
export default defineEventHandler(async (event): Promise<Trial[]> => {
  await requireUserSession(event);

  const gateName = getRouterParam(event, "stage") ?? "";
  const limit = getQuery(event).limit;
  const count = typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : undefined;
  const client = gateOf(event);

  try {
    const { data, error, response } = await client.GET("/trials", {
      params: { query: { gateName, limit: count } }
    });

    if (error !== undefined) {
      return refused(response.status, error);
    }

    return data?.items ?? [];
  } catch (cause) {
    if (cause instanceof Error && "statusCode" in cause) {
      throw cause;
    }

    return unreachable(cause);
  }
});
