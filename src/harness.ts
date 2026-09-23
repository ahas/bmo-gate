// What a run is, in BMO's own words and no CLI's. Every field is named for what it means to the
// run, so a second harness answers the same questions in whatever words its own program uses:
// nothing here is a flag, and nothing here may become one.
//
// Only the part a generation batch fills stands here. This repository carries no harness registry
// and starts no rooms, searches or jobs, so the lines and the fields those need are BMO's.

// The lines BMO runs, named for what the run is for rather than for the program that carries it.
export const runLines = ["chat", "gate", "worker", "search", "browse", "editor"] as const;

export type RunLine = (typeof runLines)[number];

// What comes back out of a run: a stream to be read as it arrives, one object at the end, the
// bare text, or nothing at all. A run whose result nobody follows asks for the object; a run
// something watches while it works asks for the stream.
export type AnswerShape = "stream" | "object" | "text" | "unread";

// How the prompt is handed over. Written to the run's input, standing on the command line as an
// argument of its own, or spoken to the run once it is up.
export type PromptDelivery = "input" | "argument" | "channel";

export interface HarnessRun {
  line: RunLine;
  model: string;
  // How hard the run thinks. The words are the harness's own, so this is passed through rather
  // than interpreted here.
  effort: string;
  // The system prompt as a path to a file rather than as text. The file is what the prompt cache
  // is keyed on, so handing over the path is handing over the identity of the prefix. Null where
  // the run keeps the harness's own prompt.
  systemPromptPath: string | null;
  // What the run is shown, what it may use, and what is kept from it. Shown and allowed are two
  // questions and not one: the tool definitions are the front of a cached prefix, so what is
  // shown is the same in every run of a line, and privilege is decided by what is allowed.
  // Null means the run says nothing about it and takes whatever the harness gives it.
  toolsShown: string | null;
  toolsAllowed: string | null;
  toolsDenied: string | null;
  // The file naming the MCP servers this run may reach, or null for a run that reaches none.
  mcpConfigPath: string | null;
  prompt: string;
  promptDelivery: PromptDelivery;
  // The session this run continues, and whether a session is kept at all. A judgement keeps none:
  // it is one prompt in and one text out, and a session file for it would be a file nobody reads.
  resumeSessionId: string | null;
  keepSession: boolean;
  // Whether the harness's own commands are available to the run. They are off wherever a run
  // answers a room or judges something.
  hostCommands: boolean;
  // Whether the model thinks before it answers. Off for a judgement that needs none, where the
  // thinking is what pushed the run past its timeout.
  thinking: boolean;
  answerShape: AnswerShape;
  cwd: string;
  env: Record<string, string | undefined>;
}
