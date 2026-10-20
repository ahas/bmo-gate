import { gateClient } from "bmo-gate-client";

import type { paths } from "bmo-gate-client";

import type { H3Event } from "h3";
import type { Client } from "openapi-fetch";

// One call to the gate (`docs/layout.md`, 「The console plugin bundle」) through the client generated from its
// OpenAPI document, at the address and with the token the host's runtime configuration gives under `gate`, read
// for each call.

export function gateOf(event: H3Event): Client<paths> {
  const { gate } = useRuntimeConfig(event) as unknown as { gate: { address: string; token: string } };

  if (gate.address === "") {
    throw createError({ statusCode: 503, message: "the console names no gate", data: { code: "no-gate-address" } });
  }

  return gateClient(gate.address, gate.token);
}

/** A refusal of the gate's, handed on with its status, its code and its sentence. */
export function refused(status: number, answer: { code?: string; error?: string } | undefined): never {
  throw createError({
    statusCode: status,
    message: typeof answer?.error === "string" ? answer.error : `the gate answered ${status}`,
    data: { code: typeof answer?.code === "string" ? answer.code : "gate-refused" }
  });
}

/** A gate that did not answer at all. */
export function unreachable(cause: unknown): never {
  const message = cause instanceof Error ? cause.message : "the gate does not answer";

  throw createError({ statusCode: 502, message, data: { code: "gate-unreachable" } });
}
