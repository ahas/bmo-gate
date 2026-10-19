import { readFileSync } from "node:fs";

import { refused } from "./card-adapter";
import { localDigests, nodeFileSource, pinnedLaya, reachTrainingNodes, standNode, TRAINING_PLACEMENT } from "./laya-nodes";
import { readPlacement, writePlacement } from "./placement";
import { repositoryRoot } from "./roots";

import type { AdapterAnswer, AdapterAsk } from "./card-adapter";
import type { NodeCalls, NodeRunner } from "./node-calls";
import type { NodeOutcome, StandOptions } from "./laya-nodes";

// Laya training's adapter for the card master (docs/training.md, 「The nodes」): the training placement
// kept in step with the master's placed nodes, and the training environment stood on a node it adds.
// Training stands no unit, so starting and stopping change nothing.

export interface TrainAdapterHands {
  runner: NodeRunner;
  console: string;
  /** The data root the placement stands under; the settings' by default. */
  root?: string;
  /** The repository the node's files are carried from; this one by default. */
  repository?: string;
  /** How the named node is reached, or why it may not train. */
  reach?: (node: string) => Promise<NodeCalls | string>;
  stand?: (node: string, options: StandOptions) => Promise<NodeOutcome>;
  say?: (line: string) => void;
}

async function defaultReach(node: string, hands: TrainAdapterHands): Promise<NodeCalls | string> {
  const found = await reachTrainingNodes([node], hands.runner, hands.console);
  if (typeof found === "string") {
    return found;
  }
  return found.reached.get(node) ?? found.dropped.join("; ");
}

async function standOn(node: string, training: readonly string[], hands: TrainAdapterHands, check: boolean): Promise<NodeOutcome | string> {
  const calls = await (hands.reach ?? ((name: string) => defaultReach(name, hands)))(node);
  if (typeof calls === "string") {
    return calls;
  }
  const repository = hands.repository ?? repositoryRoot();
  return (hands.stand ?? standNode)(node, {
    runner: hands.runner,
    console: hands.console,
    reach: () => calls,
    repository,
    digests: localDigests(repository),
    pinned: pinnedLaya(readFileSync(nodeFileSource(repository, "pyproject.toml"), "utf8")),
    training,
    check,
    say: hands.say,
  });
}

function answerOf(node: string, outcome: NodeOutcome): AdapterAnswer {
  return outcome.ready
    ? { ok: true, node, state: "running", detail: "ready to train" }
    : { ok: true, node, state: "failing", detail: outcome.fault ?? `short of: ${outcome.missing.join(", ")}` };
}

/** One verb of the adapter, answered. */
export async function layaTrainAdapter(ask: AdapterAsk, hands: TrainAdapterHands): Promise<AdapterAnswer> {
  const training = readPlacement(TRAINING_PLACEMENT, hands.root);
  const { node } = ask;

  if (ask.verb === "placed") {
    return { ok: true, node: null, state: null, detail: "", nodes: [...training] };
  }
  if (ask.verb === "uninstall") {
    writePlacement(TRAINING_PLACEMENT, { nodes: ask.placed.filter((one) => one !== node) }, hands.root);
    return { ok: true, node, state: "stopped", detail: "taken out of the training placement (the node's environment stays)" };
  }
  if (!training.includes(node!) && ask.verb !== "install") {
    return { ok: true, node, state: "absent", detail: `${node} is not in the training placement` };
  }
  if (ask.verb === "install") {
    const placed = ask.placed.includes(node!) ? ask.placed : [...ask.placed, node!];
    writePlacement(TRAINING_PLACEMENT, { nodes: placed }, hands.root);
    const outcome = await standOn(node!, placed, hands, false);
    if (typeof outcome === "string") {
      return refused(node, outcome);
    }
    const answer = answerOf(node!, outcome);
    return answer.state === "running" ? answer : refused(node, answer.detail);
  }
  // health, and start and stop, which a node standing no unit answers the same way
  const outcome = await standOn(node!, training, hands, true);
  return typeof outcome === "string" ? refused(node, outcome) : answerOf(node!, outcome);
}
