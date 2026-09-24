import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bmoIdFrom, messagesIn, openArchive, ownerIdFrom } from "../src/archive";
import { codexEffort, codexJudgeRoad, codexModel } from "../src/codex-road";
import { asksUsage, lastOf, readFlags } from "../src/flags";
import { addTokens, noTokens } from "../src/laya-synth-run";
import { pseudonyms } from "../src/pii";
import {
  clearingTau, gateFigures, labelTurns, layaAnswersOf, readUseAnswer, trainingRows, useBatches, useGates, usePrompt,
  useSystem, useTurns,
} from "../src/reference-use";
import { dataPath, refuseInsideCheckout } from "../src/roots";

import type { TokenTally } from "../src/laya-synth-run";
import type { LayaRequest } from "../src/laya";
import type { LayaAnswers, UseLabel, UseReads, UseTurn } from "../src/reference-use";

// Whether BMO's answers used what the reference gates attached, judged on the codex road, and the
// figures and training rows that follow from it (docs/reference-use.md).

const usage = `usage: bun scripts/reference-use.ts <실행> [--limit <n>] [--at-once <n>] [--effort <수준>] [--bar <비율>] [--db <경로>] [--owner <번호>] [--bmo <번호>] [--seed <씨앗>] [--checkout <경로>] [--laya <주소>]

참조 게이트 네 개가 턴에 붙인 문서를 비모가 실제로 보낸 답이 썼는지 판정하고, 게이트마다 과다 선택·누락과
Laya 점수를 새로 내고, 판정을 학습 행 모양으로 쓴다(docs/reference-use.md).
<실행> 은 런타임 데이터 뿌리의 reference-use/ 아래 이름이거나 절대 경로다. 굳은 묶음에 든 턴은 다시 판정하지 않는다.
--limit 은 판정할 턴 수(연습용). --at-once 는 동시에 판정할 묶음 수(기본 4). --effort 는 codex 추론 수준(기본 ${codexEffort}).
--bar 는 Laya가 맡는 판정이 넘어야 할 정확도(기본 0.98). --checkout 은 비모의 라이브 체크아웃(기본 ~/.local/share/bmo/deploy).
--laya 는 Laya 서버 주소(기본 BMO_LAYA_URL, 없으면 http://192.0.2.8x:7431).`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--limit": true, "--at-once": true, "--effort": true, "--bar": true, "--db": true, "--owner": true, "--bmo": true,
  "--seed": true, "--checkout": true, "--laya": true,
});

if (!reading.ok || reading.loose.length !== 1) {
  console.error(`reference-use: ${reading.trouble ?? "실행 이름을 하나 주세요."}`);
  console.error(usage);
  process.exit(2);
}

const name = reading.loose[0]!;
const root = name.startsWith("/") ? name : dataPath("reference-use", name);
const refusal = refuseInsideCheckout(root);

if (refusal !== null) {
  console.error(refusal);
  process.exit(2);
}

const home = process.env.HOME ?? "";
const checkout = lastOf(reading, "--checkout") ?? join(home, ".local", "share", "bmo", "deploy");
const brain = dataPath("brain");
const layaUrl = (lastOf(reading, "--laya") ?? process.env.BMO_LAYA_URL ?? "http://192.0.2.8x:7431").replace(/\/$/, "");
const layaToken = readFileSync(dataPath("env", "laya.token"), "utf8").trim();
const bar = Number(lastOf(reading, "--bar") ?? "0.98");
const atOnce = Math.max(1, Number(lastOf(reading, "--at-once") ?? "4"));
const effort = lastOf(reading, "--effort") ?? codexEffort;
const dbPath = lastOf(reading, "--db");
const db = openArchive(dbPath === undefined ? undefined : dbPath);
const ownerId = Number(lastOf(reading, "--owner") ?? ownerIdFrom());
const bmoId = Number(lastOf(reading, "--bmo") ?? bmoIdFrom());
const who = { ownerId, bmoId, names: pseudonyms(lastOf(reading, "--seed") ?? "laya-real", { ownerId, bmoId }) };
const shares = { calibration: 0.15, test: 0.15 };

// A fragment's body path is relative to the checkout for the system documents and the lore and to
// the brain for the rest; a path is looked for in the brain first and in the checkout after.
function bodyAt(path: string): string | null {
  for (const base of [brain, checkout]) {
    const full = join(base, path);

    if (existsSync(full)) {
      return readFileSync(full, "utf8");
    }
  }

  return null;
}

const reads: UseReads = {
  candidates: () => (db.query(`SELECT stage, chat_id AS chatId, message_id AS messageId, slug, llm, attached
      FROM reference_verdicts WHERE message_id IS NOT NULL ORDER BY id`).all() as
      { stage: string; chatId: number; messageId: number; slug: string; llm: number | null; attached: number | null }[])
    .map((one) => ({ ...one, llm: one.llm === 1, attached: one.attached === null ? null : one.attached === 1 })),
  probes: () => (db.query(`SELECT stage, chat_id AS chatId, message_id AS messageId, input FROM laya_verdicts
      WHERE message_id IS NOT NULL AND input <> '' AND input <> '{}' ORDER BY id`).all() as
      { stage: string; chatId: number; messageId: number; input: string }[])
    .flatMap((one) => {
      try {
        const request = JSON.parse(one.input) as { state?: unknown; questions?: unknown };

        return typeof request.questions === "object" && request.questions !== null && request.state !== undefined
          ? [{ stage: one.stage, chatId: one.chatId, messageId: one.messageId, request: request as never }]
          : [];
      } catch {
        return [];
      }
    }),
  room: (chatId) => messagesIn(db, chatId),
  fragment: (chatId, slug) => {
    const row = db.query(`SELECT title, path FROM fragments WHERE slug = ?
        ORDER BY (chat_id = ?) DESC, (chat_id IS NULL) DESC, active DESC LIMIT 1`).get(slug, chatId) as
        { title: string; path: string } | null;

    return row === null ? null : { line: `${slug}: ${row.title}`, body: bodyAt(row.path) };
  },
};

const built = useTurns(reads, who);
const limit = lastOf(reading, "--limit");
const turns = limit === undefined ? built.turns : built.turns.slice(0, Number(limit));
const batches = join(root, "batches");

mkdirSync(batches, { recursive: true });

interface FrozenUse {
  turns: string[];
  answer: string;
  tokens: TokenTally;
  labels: Record<string, Record<string, UseLabel>>;
}

// What earlier runs froze. A turn is judged once: a run taken up again, or run again after the
// record has grown, judges only the turns no frozen batch carries.
const frozen: FrozenUse[] = readdirSync(batches).filter((file) => file.endsWith(".json")).sort()
  .map((file) => JSON.parse(readFileSync(join(batches, file), "utf8")) as FrozenUse);
const judged = new Set(frozen.flatMap((one) => one.turns));
const plan = useBatches(turns.filter((turn) => !judged.has(turn.id)));
const base = frozen.length;
const road = codexJudgeRoad({ model: codexModel, effort });
let failures = 0;

console.log(`턴 ${turns.length}개(답 없음 ${built.skipped.noReply}, 메시지 없음 ${built.skipped.noMessage}, 붙음 기록 없음 ${built.skipped.noAttachment}) · 굳은 묶음 ${frozen.length}개 · 새 묶음 ${plan.length}개`);

async function judge(batch: UseTurn[], at: number): Promise<void> {
  try {
    const answer = await road(useSystem, usePrompt(batch), null);
    const labels = readUseAnswer(answer.text, batch);
    const one: FrozenUse = {
      turns: batch.map((turn) => turn.id),
      answer: answer.text,
      tokens: answer.tokens,
      labels: Object.fromEntries([...labels].map(([id, kept]) => [id, Object.fromEntries(kept)])),
    };

    writeFileSync(join(batches, `${String(base + at).padStart(4, "0")}.json`), `${JSON.stringify(one)}\n`);
    frozen.push(one);
    console.log(`묶음 ${at + 1}/${plan.length} 굳음`);
  } catch (error) {
    failures += 1;
    console.error(`묶음 ${at + 1}: ${(error as Error).message}`);
  }
}

for (let next = 0; next < plan.length; next += atOnce) {
  await Promise.all(plan.slice(next, next + atOnce).map((batch, at) => judge(batch, next + at)));
}

labelTurns(turns, new Map(frozen.flatMap((one) => Object.entries(one.labels))
  .map(([id, kept]) => [id, new Map(Object.entries(kept))])));

// Laya asked again, turn by turn, as the server serves each gate now.
const laya = new Map<string, LayaAnswers>();
const served = new Set<string>();

try {
  const health = await (await fetch(`${layaUrl}/health`, { headers: { authorization: `Bearer ${layaToken}` } })).json() as
    { gates?: Record<string, { model?: string }> };

  for (const gate of Object.keys(health.gates ?? {})) {
    served.add(gate);
  }
} catch (error) {
  console.error(`Laya 서버에 닿지 않았습니다 — ${(error as Error).message}`);
}

let layaFailures = 0;

// One decision, asked once more where the connection itself dropped: the server closes an idle
// connection the client may still be about to reuse, and that is not an answer about the turn.
async function askLaya(gate: (typeof useGates)[number], request: LayaRequest): Promise<LayaAnswers | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reply = await fetch(`${layaUrl}/decide`, {
        method: "POST",
        headers: { authorization: `Bearer ${layaToken}`, "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ gate, state: request.state, questions: request.questions }),
      });

      return reply.ok ? layaAnswersOf(gate, await reply.json()) : null;
    } catch {
      // Asked again below, once.
    }
  }

  return null;
}

// Gate by gate rather than turn by turn: the server keeps one checkpoint on the card, and asking
// the gates in turn would move a checkpoint onto it on every call.
for (const gate of useGates) {
  for (const turn of turns) {
    const request = turn.probes[gate];

    if (request === undefined || !served.has(gate)) {
      continue;
    }

    const answers = await askLaya(gate, request);

    if (answers === null) {
      layaFailures += 1;
    } else {
      laya.set(`${turn.id}/${gate}`, answers);
    }
  }
}

writeFileSync(join(root, "turns.jsonl"), turns.map((turn) => `${JSON.stringify({
  id: turn.id,
  candidates: turn.candidates.map(({ gate, slug, llm, attached, bodyHash, label }) => ({ gate, slug, llm, attached, bodyHash, label })),
})}\n`).join(""));
writeFileSync(join(root, "laya.jsonl"), [...laya].map(([key, answers]) => `${JSON.stringify({ key, answers })}\n`).join(""));

const figures = useGates.map((gate) => gateFigures(gate, turns, laya));
const rows = Object.fromEntries(useGates.map((gate) => {
  const outcome = trainingRows(gate, turns, shares);
  const folder = join(root, "gates", gate);

  mkdirSync(folder, { recursive: true });

  for (const split of ["train", "calibration", "test"] as const) {
    writeFileSync(join(folder, `${split}.jsonl`), outcome.rows.filter((row) => row.split === split).map((row) => `${JSON.stringify(row)}\n`).join(""));
  }

  return [gate, { rows: outcome.rows.length, refusals: outcome.refusals }];
}));
const tokens = frozen.reduce((sum, one) => addTokens(sum, one.tokens), noTokens);
const report = {
  written: new Date().toISOString(),
  model: codexModel,
  effort,
  served: [...served],
  layaCalls: laya.size,
  layaFailures,
  turns: turns.length,
  skipped: built.skipped,
  calls: frozen.length,
  failedBatches: failures,
  unjudgedTurns: turns.filter((turn) => !frozen.some((one) => one.turns.includes(turn.id))).length,
  tokens,
  bar,
  gates: figures.map((one) => ({ ...one, clearing: clearingTau(one, bar) })),
  rows,
};

writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${root}/report.json 에 썼어요.`);

for (const one of report.gates) {
  const cleared = one.clearing === null ? "못 넘음" : `τ ${one.clearing.tau} 에서 ${one.clearing.settled}턴`;

  console.log(`${one.gate.padEnd(18)} 턴 ${one.turns} · 붙임 ${one.attached} (씀 ${one.used} · 관련 ${one.related} · 안 씀 ${one.unused}) · 누락 턴 ${one.missTurns} · Laya ${one.laya?.turns ?? 0}턴 · ${cleared}`);
}

process.exit(failures > 0 ? 1 : 0);
