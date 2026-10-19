// What the gate answers the console with (the gate's `docs/boundary-api.md`, 「For the console」), as the server
// routes hand it to the page. Times are Unix seconds.

/** One trial: a prompt put to one gate as a turn would, with who asked and what came back. */
export interface Trial {
  id: number;
  stage: string;
  user: string;
  prompt: string;
  answer: string | null;
  ms: number;
  created_at: number;
}

/** How often Laya agrees with a gate's LLM, where it was ever compared. */
export interface LayaAgreement {
  agreement: number | null;
}

/** One gate Laya is asked on, as `GET /laya` answers it. */
export interface LayaGate {
  stage: string;
  mode: string;
  tau: number | null;
  agreement: LayaAgreement | null;
}

/** Laya as `GET /laya` answers it: what the page reads of it. */
export interface LayaView {
  gates: LayaGate[];
  modes: string[];
}

/** A refusal of the gate's, as a server route hands it on: its status, its code and its English sentence. */
export interface GateRefusal {
  code: string;
  error: string;
}
