// The gate's contract in TypeScript (docs/api.md): the types openapi-typescript generates from
// docs/openapi.json, and a client over them that carries the token on every call.

import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "./openapi";

export type { components, paths };

type Schemas = components["schemas"];

export type Gate = Schemas["Gate"];
export type GateOptions = Schemas["GateOptions"];
export type GateRoute = Schemas["GateRoute"];
export type GateOptionChange = Schemas["GateOptionChange"];
export type LayaView = Schemas["LayaView"];
export type Judgement = Schemas["Judgement"];
export type JudgementPage = Schemas["JudgementPage"];
export type NewJudgement = Schemas["NewJudgement"];
export type Trial = Schemas["Trial"];
export type TrialPage = Schemas["TrialPage"];
export type NewTrial = Schemas["NewTrial"];
export type Health = Schemas["Health"];
export type ErrorBody = Schemas["ErrorBody"];

/**
 * A client of the gate at `baseUrl`, sending `token` as its bearer token. Each call is a route of the
 * OpenAPI document, typed by it: `client.GET("/options/{gateName}", { params: { path: { gateName } } })`.
 */
export function gateClient(baseUrl: string, token: string, fetch?: typeof globalThis.fetch): Client<paths> {
  return createClient<paths>({
    baseUrl,
    headers: { Authorization: `Bearer ${token}` },
    ...(fetch ? { fetch } : {}),
  });
}
