// What the gate answers the console with (the gate's `docs/api.md`), as the server routes hand it to the page.
// Every time is epoch milliseconds.

export type { LayaView, Trial } from "bmo-gate-client";

/** A refusal of the gate's, as a server route hands it on: its status, its code and its English sentence. */
export interface GateRefusal {
  code: string;
  error: string;
}
