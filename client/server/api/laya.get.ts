import { askGate } from "../utils/gate";

import type { LayaView } from "../../shared/gate";

// Laya as the gate answers it (the gate's `docs/laya.md`): its last health check and each gate's mode and agreement
// with its LLM. The gate is the one writer; this reads and never makes.
export default defineEventHandler(async (event): Promise<LayaView> => {
  await requireUserSession(event);

  return askGate<LayaView>(event, "/laya");
});
