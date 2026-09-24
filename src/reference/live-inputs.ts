import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { isReferenceGate } from "./labels";

import type { LayaRequest } from "../laya";
import type { ReferenceGate } from "./labels";

// What BMO would hand each reference gate for a turn today, asked of BMO's own code
// (docs/reference-data.md, 「The input」). This repository never builds a gate's input itself: BMO's
// narrowing and its probes do, and what they answer is taken as it stands.

export const inputsScript = join("scripts", "reference-inputs.ts");

// What the script's answer may run to: every turn of every room with a hundred and more candidates
// each is some hundreds of megabytes.
const answerBytes = 1 << 30;

export interface InputsAsk {
  chatId: number;
  messageIds: number[];
  // The pieces whose body and index line are wanted, by gate.
  bodies?: Partial<Record<ReferenceGate, string[]>>;
}

export interface LiveGate {
  gate: ReferenceGate;
  request: LayaRequest;
  // Each candidate kept and its index line, in the order the gate reads them.
  candidates: { slug: string; about: string }[];
  held: number;
  capped: number;
}

export interface LivePiece {
  gate: ReferenceGate;
  slug: string;
  about: string | null;
  body: string | null;
}

export interface LiveTurn {
  chatId: number;
  messageIds: number[];
  // Whether one of the turn's messages is gone from the archive.
  missing: boolean;
  gates: LiveGate[];
  pieces: LivePiece[];
}

export type InputsReader = (asks: readonly InputsAsk[]) => LiveTurn[];

// One line of the script's answer, read into its shape. A gate this repository does not train is
// passed over.
export function readLiveTurn(line: string): LiveTurn {
  const said = JSON.parse(line) as {
    chatId: number;
    messageIds: number[];
    missing?: boolean;
    gates?: { gate: string; request: LayaRequest; candidates: { slug: string; about: string }[]; held: number; capped: number }[];
    pieces?: { gate: string; slug: string; about: string | null; body: string | null }[];
  };

  return {
    chatId: said.chatId,
    messageIds: said.messageIds,
    missing: said.missing === true,
    gates: (said.gates ?? []).flatMap((one) => isReferenceGate(one.gate)
      ? [{ gate: one.gate, request: one.request, candidates: one.candidates, held: one.held, capped: one.capped }]
      : []),
    pieces: (said.pieces ?? []).flatMap((one) => isReferenceGate(one.gate) ? [{ ...one, gate: one.gate }] : []),
  };
}

// The script in BMO's live checkout, pointed at the pass's archive copy and handed the turns on its
// standard input. It is run with the environment it is given, which is where BMO's own settings —
// the bot's number among them — come from.
export function bmoInputs(checkout: string, archive: string, env: Record<string, string | undefined> = process.env): InputsReader {
  return (asks) => {
    if (asks.length === 0) {
      return [];
    }

    const ran = spawnSync("bun", [inputsScript, "--db", archive], {
      cwd: checkout,
      env,
      input: asks.map((one) => `${JSON.stringify(one)}\n`).join(""),
      encoding: "utf8",
      maxBuffer: answerBytes,
    });

    if (ran.status !== 0) {
      throw new Error(`BMO 의 ${inputsScript} 가 실패했어요 (${ran.status ?? ran.signal}) — ${(ran.stderr ?? "").trim().split("\n").slice(-3).join(" / ")}`);
    }

    const read = ran.stdout.split("\n").filter((line) => line.trim() !== "").map(readLiveTurn);

    if (read.length !== asks.length) {
      throw new Error(`BMO 의 ${inputsScript} 가 턴 ${asks.length}개에 ${read.length}줄로 답했어요.`);
    }

    return read;
  };
}

// The commit of BMO's checkout that built the inputs, recorded with the pass.
export function bmoCommit(checkout: string): string | null {
  const ran = spawnSync("git", ["-C", checkout, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });

  return ran.status === 0 ? ran.stdout.trim() : null;
}
