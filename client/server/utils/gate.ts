import { FetchError } from "ofetch";

import type { H3Event } from "h3";

import type { GateRefusal } from "../../shared/gate";

// One call to the gate (`docs/layout.md`, 「The console plugin bundle」): at the address and with the token the
// host's runtime configuration gives under `gate`, read for each call. A refusal of the gate's is handed on with
// its status and its code, the English sentence as its message; a gate that does not answer is a 502.
export async function askGate<T>(
  event: H3Event,
  path: string,
  options: { method?: "GET" | "POST"; body?: Record<string, unknown>; query?: Record<string, string> } = {}
): Promise<T> {
  const { gate } = useRuntimeConfig(event) as unknown as { gate: { address: string; token: string } };

  if (gate.address === "") {
    throw createError({ statusCode: 503, message: "the console names no gate", data: { code: "no_gate_address" } });
  }

  try {
    // The gate is another service, so its answer is the shape its boundary states rather than one of this
    // server's own routes.
    const answer: unknown = await $fetch(path, {
      baseURL: gate.address,
      method: options.method ?? "GET",
      body: options.body,
      query: options.query,
      headers: { authorization: `Bearer ${gate.token}` }
    });

    return answer as T;
  } catch (cause) {
    if (cause instanceof FetchError && cause.statusCode !== undefined) {
      const refusal = cause.data as Partial<GateRefusal> | undefined;

      throw createError({
        statusCode: cause.statusCode,
        message: typeof refusal?.error === "string" ? refusal.error : `the gate answered ${cause.statusCode}`,
        data: { code: typeof refusal?.code === "string" ? refusal.code : "gate_refused" }
      });
    }

    throw createError({ statusCode: 502, message: "the gate does not answer", data: { code: "gate_unreachable" } });
  }
}
