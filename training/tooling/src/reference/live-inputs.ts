import { spawnSync } from "node:child_process";

import { settingWords } from "../settings";
import { isReferenceGate } from "./labels";

import type { LayaRequest } from "../laya";
import type { ReferenceGate } from "./labels";
import type { WorkWords } from "./turns";

// What the gate would hand each reference gate for a turn today, asked of the gate's own code
// (docs/reference-data.md, 「The input」). The tooling never builds a gate's input itself: the gate's
// narrowing and its probes do, and what they answer is taken as it stands.

// The gate's unit command as the tooling's settings name it (`gate_command`), and the noun that answers.
export function gateCommand(): string[] {
  return settingWords("gate_command");
}

export const inputsNoun = ["reference", "inputs"] as const;

// What the verb's answer may run to: every turn of every room with a hundred and more candidates
// each is some hundreds of megabytes.
const answerBytes = 1 << 30;

export interface InputsAsk {
  chatId: number;
  messageIds: number[];
  // The bot's own instructions the turn was handed, where there were any.
  instructions?: string;
  // A piece of work's words, asked for in place of messages.
  work?: WorkWords;
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
  // The instructions the answer was built over, as the script repeats them back.
  instructions?: string;
  // The work the answer was built over, as the script repeats it back.
  work?: WorkWords;
  // Whether one of the turn's messages is gone from the receiver, or the instructions it was asked
  // over were not read.
  missing: boolean;
  gates: LiveGate[];
  pieces: LivePiece[];
}

export type InputsReader = (asks: readonly InputsAsk[]) => LiveTurn[];

// One line of the verb's answer, read into its shape. A gate this project does not train is
// passed over.
export function readLiveTurn(line: string): LiveTurn {
  const said = JSON.parse(line) as {
    chatId: number;
    messageIds: number[];
    instructions?: string;
    work?: WorkWords;
    missing?: boolean;
    gates?: { gate: string; request: LayaRequest; candidates: { slug: string; about: string }[]; held: number; capped: number }[];
    pieces?: { gate: string; slug: string; about: string | null; body: string | null }[];
  };

  return {
    chatId: said.chatId,
    messageIds: said.messageIds,
    ...said.instructions === undefined ? {} : { instructions: said.instructions },
    ...said.work === undefined ? {} : { work: said.work },
    missing: said.missing === true,
    gates: (said.gates ?? []).flatMap((one) => isReferenceGate(one.gate)
      ? [{ gate: one.gate, request: one.request, candidates: one.candidates, held: one.held, capped: one.capped }]
      : []),
    pieces: (said.pieces ?? []).flatMap((one) => isReferenceGate(one.gate) ? [{ ...one, gate: one.gate }] : []),
  };
}

// The gate's noun, run as the command names it and handed the turns on its standard input. It reads
// the gate's own settings, the units it asks among them, from the environment it is given.
export function gateInputs(command: readonly string[] = gateCommand(), env: Record<string, string | undefined> = process.env): InputsReader {
  return (asks) => {
    if (asks.length === 0) {
      return [];
    }

    const [program, ...words] = command;
    const ran = spawnSync(program!, [...words, ...inputsNoun], {
      env,
      input: asks.map((one) => `${JSON.stringify(one)}\n`).join(""),
      encoding: "utf8",
      maxBuffer: answerBytes,
    });

    if (ran.status !== 0) {
      throw new Error(`bmo-gate ${inputsNoun.join(" ")} failed (${ran.status ?? ran.signal}): ${(ran.stderr ?? "").trim().split("\n").slice(-3).join(" / ")}`);
    }

    const read = ran.stdout.split("\n").filter((line) => line.trim() !== "").map(readLiveTurn);

    if (read.length !== asks.length) {
      throw new Error(`bmo-gate ${inputsNoun.join(" ")} answered ${asks.length} turns with ${read.length} lines.`);
    }

    return read.map((one, index) => checkRepeated(asks[index]!, one));
  };
}

// A turn asked over instructions, or a piece of work asked for by its words, whose answer does not
// repeat them back was answered by a checkout that does not read them — for a turn with no lines at
// all — and is missing (docs/reference-data.md, 「The input」).
export function checkRepeated(ask: InputsAsk, live: LiveTurn): LiveTurn {
  const instructionsRead = ask.instructions === undefined || live.instructions === ask.instructions;
  const workRead = ask.work === undefined || JSON.stringify(live.work) === JSON.stringify(ask.work);

  return instructionsRead && workRead ? live : { ...live, missing: true, gates: [], pieces: [] };
}

// The version of the gate that built the inputs, as its command says it, recorded with the pass.
export function gateVersion(command: readonly string[] = gateCommand()): string | null {
  const [program, ...words] = command;
  const ran = spawnSync(program!, [...words, "--version"], { encoding: "utf8" });

  return ran.status === 0 ? ran.stdout.trim() : null;
}
