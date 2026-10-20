import { gateOf, refused, unreachable } from "../utils/gate";

import type { LayaView } from "../../shared/gate";

// Laya as the gate answers it (the gate's `docs/laya.md`): its last health check and each gate's mode and agreement
// with its LLM. The gate is the one writer; this reads and never makes.
export default defineEventHandler(async (event): Promise<LayaView> => {
  await requireUserSession(event);

  const client = gateOf(event);

  try {
    const { data, error, response } = await client.GET("/laya");

    if (error !== undefined) {
      return refused(response.status, error);
    }

    return data as LayaView;
  } catch (cause) {
    if (cause instanceof Error && "statusCode" in cause) {
      throw cause;
    }

    return unreachable(cause);
  }
});
