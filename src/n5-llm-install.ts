import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { homeCommand, nodeCalls, parseHome, runFault } from "./jake";
import { dataPath, sourceRoot } from "./roots";
import {
  envModeCommand, ensureKey, healthUrl, installTunnelledService, parseSetupEnd, setupLaunchCommand, setupTailCommand, unitsCommand,
} from "./tunnel-install";

import type { NodeRunner } from "./jake";
import type { InstallOptions, InstallOutcome, SetupEnd, TunnelledService } from "./tunnel-install";

// The uncensored text model as its installs see it (docs/n5-llm.md, 「Installing and updating」). One
// engine answers, on the head node, whose front is reached from main-host through its tunnel door; the
// engine lays the model and the KV store of the whole context across the head's own card and the cards
// of other nodes it borrows over the inner network. The head is a tunnelled service like n6's; a card
// node runs only the small holder that lends its card while the head asks. The service keeps the name
// n5-llm after where it began.

// The node whose front answers. It is the only text node a caller reaches.
export const TEXT_HEAD = "n5";
export const TEXT_NODES = [TEXT_HEAD] as const;
export type TextNode = (typeof TEXT_NODES)[number];

/** A card the head borrows: its node, its address on the inner network, its share of the model's
 * blocks, and whether its node's card is taken in turns by the card lock. */
export interface TextCard {
  node: string;
  address: string;
  share: number;
  lock: boolean;
}

// In the order the model's blocks go to them; the head's own card takes the last blocks, the MTP head
// and the output after them. The shares are the ones measured to fit every card with the reservations of
// the full context (docs/n5-llm.md, 「Where everything lies」). n6's card is shared with Laya, BMO's
// voice and its songs, which take it under the lock while this share stays, so n6 takes the least and
// keeps the room the voice needs to speak; it takes no lock, since holding n6's would refuse Laya.
export const TEXT_CARDS: readonly TextCard[] = [
  { node: "n2", address: "192.0.2.17", share: 18, lock: true },
  { node: "n3", address: "192.0.2.18", share: 18, lock: true },
  { node: "n4", address: "192.0.2.19", share: 18, lock: true },
  { node: "n6", address: "192.0.2.21", share: 4, lock: false },
];
export const HEAD_SHARE = 8;

// The longest KV store whose attention is computed on the f16 copy of the store; past it the vector
// kernel reads the quantized store as it lies. The head's engine and every card's rpc-server read it,
// since each card reserves and chooses for its own blocks.
export const FA_F16_MAX_KV = 262144;

// The head's port on main-host's loopback, clear of n6's (18010) and the bridge's own (18022).
const HEAD_LISTEN = "127.0.0.1:18020";

// The node-side names, one set for every node since the nodes share no filesystem.
export const N5_SERVICE_DIR = "n5-llm";
export const N5_CONFIG_DIR = ".config/n5-llm";
const GPU_LOCK = "/home/labuser/.gpu.lock";

const ENGINE_PATCHES = ["llama-fa-f16-limit.patch", "llama-rpc-slot-pieces.patch"];

/** What goes across from `n5-llm/` to the head. The tests stay here. */
export const N5_FILES: readonly string[] = [
  "front.py", "pyproject.toml", "node-setup.sh", ...ENGINE_PATCHES, "n5-llm-front.service", "n5-llm-tunnel.service",
];

/** What goes across from `n5-llm/` to a card node. */
export const CARD_FILES: readonly string[] = ["card.py", "pyproject.toml", "node-setup.sh", ...ENGINE_PATCHES, "n5-llm-card.service"];

export const N5_UNITS: readonly string[] = ["n5-llm-front.service", "n5-llm-tunnel.service"];
export const CARD_UNITS: readonly string[] = ["n5-llm-card.service"];

export function isTextNode(node: string): node is TextNode {
  return (TEXT_NODES as readonly string[]).includes(node);
}

export function textCard(node: string): TextCard | undefined {
  return TEXT_CARDS.find((card) => card.node === node);
}

function listenOf(node: string): string {
  if (!isTextNode(node)) {
    throw new Error(`${node} 는 답하는 텍스트 모델 노드가 아닙니다 (${TEXT_NODES.join(", ")}).`);
  }

  return HEAD_LISTEN;
}

/** The service's own key file on main-host, which is also its tunnel's key at the door and the key
 * the head asks its borrowed cards with. n5's keeps its first name. */
export function textKeyPath(node: string = TEXT_HEAD): string {
  return dataPath("env", `${node}-llm.token`);
}

/** The base URL an OpenAI client is given on main-host for the head's front. */
export function textBaseUrl(node: string = TEXT_HEAD): string {
  return `http://${listenOf(node)}/v1`;
}

/** The head's settings: its key and main-host port, and the cards its engine borrows. */
export function headEnvText(key: string): string {
  const cards = TEXT_CARDS.map((card) => `${card.address}:${card.share}`).join(" ");
  return `LLM_KEY=${key}\nLISTEN=${HEAD_LISTEN}\nN5_LLM_ROLE=head\nN5_LLM_CARDS="${cards}"\nN5_LLM_SHARE=${HEAD_SHARE}\n`
    + `GGML_CUDA_FA_F16_MAX_KV=${FA_F16_MAX_KV}\n`;
}

/** A card node's settings: the head's key it answers to, the address it waits on, and its lock. */
export function cardEnvText(card: TextCard, key: string): string {
  return `LLM_KEY=${key}\nN5_LLM_ROLE=card\nCARD_ADDRESS=${card.address}\nCARD_LOCK=${card.lock ? GPU_LOCK : ""}\n`
    + `GGML_CUDA_FA_F16_MAX_KV=${FA_F16_MAX_KV}\n`;
}

/** The head as the shared tunnelled install reads it (`src/tunnel-install.ts`). */
export function textModelService(node: string = TEXT_HEAD): TunnelledService {
  const listen = listenOf(node);

  return {
    node,
    serviceDir: N5_SERVICE_DIR,
    configDir: N5_CONFIG_DIR,
    keyPath: () => textKeyPath(node),
    envFileText: headEnvText,
    makeDirsCommand: () => `mkdir -p ~/${N5_SERVICE_DIR}/models ~/${N5_SERVICE_DIR}/slots ~/${N5_CONFIG_DIR} && chmod 700 ~/${N5_CONFIG_DIR}`,
    carried: (checkout, home) => [
      ...N5_FILES.map((name): [string, string] => [join(checkout, "n5-llm", name), `${home}/${N5_SERVICE_DIR}/${name}`]),
      // The tunnel dials the door the way n6's does, with the same client.
      [join(checkout, "llm-server", "ws-dial.py"), `${home}/${N5_SERVICE_DIR}/ws-dial.py`],
    ],
    setupDone: "N5-LLM-SETUP-DONE",
    units: N5_UNITS,
    listen,
    engineUnit: "n5-llm-front",
    label: `${node} 텍스트 모델 머리(앞단, llama.cpp, 모델 파일)`,
  };
}

export function textHealthUrl(node: string = TEXT_HEAD): string {
  return healthUrl(textModelService(node));
}

export function installTextModel(node: string, options: InstallOptions): Promise<InstallOutcome> {
  return installTunnelledService(textModelService(node), options);
}

export type CardStep = "key" | "home" | "env" | "upload" | "setup" | "units" | "waiting";

export interface CardOutcome {
  ok: boolean;
  step: CardStep | null;
  fault: string | null;
  done: CardStep[];
}

export interface CardOptions {
  runner: NodeRunner;
  console: string;
  checkout?: string;
  keyPath?: string;
  tmpRoot?: string;
  wait?: (ms: number) => Promise<void>;
  setupPolls?: number;
  setupEveryMs?: number;
  say?: (line: string) => void;
}

/** A node that runs as a card stops whatever a head left there, so its card is the holder's alone. */
export function cardUnitsCommand(): string {
  const runtime = "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";
  const headUnits = N5_UNITS.join(" ");
  return `${runtime} && (systemctl --user disable --now ${headUnits} 2>/dev/null; `
    + `rm -f ${N5_UNITS.map((unit) => `~/.config/systemd/user/${unit}`).join(" ")}; true) && `
    + unitsCommand({ serviceDir: N5_SERVICE_DIR, units: CARD_UNITS });
}

/** The holder waiting on its address, asked of the node itself, since main-host is not on the inner
 * network. */
export function cardWaitingCommand(card: TextCard): string {
  const runtime = "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";
  return `${runtime} && for i in $(seq 1 20); do ss -ltn | grep -q '${card.address}:50051 ' && { echo CARD-WAITING; exit 0; }; sleep 1; done; `
    + `systemctl --user is-active ${CARD_UNITS[0]}; exit 1`;
}

/** One card node stood up or brought up to date, one step after another, stopping at the first that
 * fails and saying which. */
export async function installTextCard(card: TextCard, options: CardOptions): Promise<CardOutcome> {
  const say = options.say ?? (() => {});
  const wait = options.wait ?? ((ms: number) => new Promise<void>((keep) => setTimeout(keep, ms)));
  const checkout = options.checkout ?? sourceRoot();
  const done: CardStep[] = [];
  const stop = (step: CardStep, fault: string): CardOutcome => ({ ok: false, step, fault, done });
  const { exec, upload } = nodeCalls(options.runner, options.console, card.node);

  // 1. The head's key, which the holder answers to.
  const keyed = ensureKey(options.keyPath ?? textKeyPath(TEXT_HEAD));
  if (typeof keyed === "string") {
    return stop("key", keyed);
  }
  done.push("key");

  const asked = await exec(homeCommand());
  const home = parseHome(asked.stdout);
  if (home === null) {
    return stop("home", `${card.node} 가 답하지 않아요 — ${runFault(asked)}`);
  }
  const made = await exec(`mkdir -p ~/${N5_SERVICE_DIR}/slots ~/${N5_SERVICE_DIR}/rpc-cache ~/${N5_CONFIG_DIR} && chmod 700 ~/${N5_CONFIG_DIR}`);
  if (made.code !== 0) {
    return stop("home", `폴더를 만들지 못했어요 — ${runFault(made)}`);
  }
  done.push("home");

  // 2. The settings file, made privately here and carried across whole.
  const scratch = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `${N5_SERVICE_DIR}-card-env-`));
  try {
    const envPath = join(scratch, "env");
    writeFileSync(envPath, cardEnvText(card, keyed.key), { mode: 0o600 });
    const carried = await upload(envPath, `${home}/${N5_CONFIG_DIR}/env`);
    if (carried.code !== 0) {
      return stop("env", `환경 파일을 올리지 못했어요 — ${runFault(carried)}`);
    }
    const moded = await exec(envModeCommand({ configDir: N5_CONFIG_DIR }));
    if (moded.code !== 0) {
      return stop("env", `환경 파일 권한을 맞추지 못했어요 — ${runFault(moded)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  done.push("env");

  // 3. The holder's files.
  for (const name of CARD_FILES) {
    const carried = await upload(join(checkout, "n5-llm", name), `${home}/${N5_SERVICE_DIR}/${name}`);
    if (carried.code !== 0) {
      return stop("upload", `${name} 를 올리지 못했어요 — ${runFault(carried)}`);
    }
  }
  say(`${card.node}: 카드 파일 ${CARD_FILES.length}개를 올렸어요`);
  done.push("upload");

  // 4. The setup, detached and waited on.
  say(`${card.node}: 빌려주는 카드의 환경을 세우는 중`);
  const service = { serviceDir: N5_SERVICE_DIR };
  const launched = await exec(setupLaunchCommand(service));
  if (launched.code !== 0) {
    return stop("setup", `설치를 시작하지 못했어요 — ${runFault(launched)}`);
  }
  let end: SetupEnd = { done: false, ok: false, fault: null };
  for (let poll = 0; poll < (options.setupPolls ?? 160) && !end.done; poll += 1) {
    await wait(options.setupEveryMs ?? 15_000);
    end = parseSetupEnd((await exec(setupTailCommand(service))).stdout, "N5-LLM-SETUP-DONE");
  }
  if (!end.done) {
    return stop("setup", `설치가 끝나지 않았어요 — ~/${N5_SERVICE_DIR}/setup.log 를 보세요`);
  }
  if (!end.ok) {
    return stop("setup", `설치가 ${end.fault} 단계에서 멈췄어요 — ~/${N5_SERVICE_DIR}/setup.log 를 보세요`);
  }
  done.push("setup");

  // 5. The unit, in place of a head's.
  const started = await exec(cardUnitsCommand());
  if (started.code !== 0) {
    return stop("units", `유닛을 올리지 못했어요 — ${runFault(started)}`);
  }
  done.push("units");

  // 6. The holder waiting on the inner network.
  const waiting = await exec(cardWaitingCommand(card));
  if (!waiting.stdout.includes("CARD-WAITING")) {
    return stop("waiting", `${card.address}:50051 에서 기다리지 않아요 — ${card.node} 의 journalctl --user -u n5-llm-card 를 보세요`);
  }
  done.push("waiting");

  return { ok: true, step: null, fault: null, done };
}
