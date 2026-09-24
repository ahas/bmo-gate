import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bmoIdFrom, messagesIn, openArchive, ownerIdFrom } from "../src/archive";
import { codexEffort, codexJudgeRoad, codexModel } from "../src/codex-road";
import { asksUsage, lastOf, readFlags } from "../src/flags";
import { addTokens, freezeBatch, noTokens, readProgress, writeProgress } from "../src/laya-synth-run";
import { pseudonyms } from "../src/pii";
import {
  answerCounts, classifierTurn, clearingTau, contextSlug, gateFigures, labelTurns, layaAnswersOf, readUseAnswer, trainingRows,
  turnsPerBatch, useBatches, useGates, usePrompt, useSystem, useTurns,
} from "../src/reference-use";
import { dataPath, gateFolder, refuseInsideCheckout } from "../src/roots";

import type { SynthProgress, TokenTally } from "../src/laya-synth-run";
import type { LayaRequest } from "../src/laya";
import type {
  LayaAnswers, LoggedClassifierRun, LogSkip, RecordedCandidate, RecordedProbe, UseGate, UseLabel, UseReads, UseTurn,
} from "../src/reference-use";

// Whether BMO's answers used what the reference gates attached, judged on the codex road, and the
// figures and training rows that follow from it (docs/reference-use.md).

const usage = `usage: bun scripts/reference-use.ts <실행> [--limit <n>] [--at-once <n>] [--effort <수준>] [--bar <비율>] [--db <경로>] [--owner <번호>] [--bmo <번호>] [--seed <씨앗>] [--checkout <경로>] [--laya <주소>]

참조 게이트 네 개가 턴에 붙인 문서를 비모가 실제로 보낸 답이 썼는지 판정하고, 게이트마다 과다 선택·누락과
Laya 점수를 새로 내고, 판정을 학습 행 모양으로 쓴다(docs/reference-use.md).
턴은 비모의 조각별 판정 기록과, 그보다 앞선 턴은 에이전트 로그의 분류기 호출에서 읽는다.
<실행> 은 런타임 데이터 뿌리의 reference-use/ 아래 이름이거나 절대 경로다. 굳은 묶음에 든 턴은 다시 판정하지 않는다.
--limit 은 판정할 턴 수(연습용, 학습 묶음은 쓰지 않는다). --at-once 는 동시에 판정할 묶음 수(기본 4).
--effort 는 codex 추론 수준(기본 ${codexEffort}). --bar 는 Laya가 맡는 판정이 넘어야 할 정확도(기본 0.98).
--checkout 은 비모의 라이브 체크아웃(기본 ~/.local/share/bmo/deploy).
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
const limit = lastOf(reading, "--limit");

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

function turnKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

// What BMO's turn runs say reached their prompts: the run each answered message belongs to, read off
// its turn-scope line, and the pieces its context lines name.
const runOfMessage = new Map<string, string>();

for (const one of db.query(`SELECT run, substr(text, 1, instr(text || char(10), char(10)) - 1) AS line FROM agent_log
    WHERE agent = 'bmo' AND kind = 'prompt' AND text LIKE 'TURN SCOPE:%'`).all() as { run: string; line: string }[]) {
  try {
    const scope = JSON.parse(one.line.slice("TURN SCOPE:".length)) as { chatId?: number; messageIds?: number[] };

    for (const messageId of scope.messageIds ?? []) {
      runOfMessage.set(turnKey(scope.chatId ?? 0, messageId), one.run);
    }
  } catch {
    // A scope line that does not read names no message.
  }
}

const piecesOfRun = new Map<string, Set<string>>();

for (const one of db.query(`SELECT run, text FROM agent_log WHERE agent = 'bmo' AND kind = 'context'
    AND name IN ('document', 'knowledge', 'rule', 'person')`).all() as { run: string; text: string }[]) {
  piecesOfRun.set(one.run, (piecesOfRun.get(one.run) ?? new Set()).add(contextSlug(one.text)));
}

function attachedAt(chatId: number, messageId: number): ReadonlySet<string> | null {
  const run = runOfMessage.get(turnKey(chatId, messageId));

  return run === undefined ? null : piecesOfRun.get(run) ?? new Set();
}

const recordRows: RecordedCandidate[] = (db.query(`SELECT stage, chat_id AS chatId, message_id AS messageId, slug, llm, attached
    FROM reference_verdicts WHERE message_id IS NOT NULL ORDER BY id`).all() as
    { stage: string; chatId: number; messageId: number; slug: string; llm: number | null; attached: number | null }[])
  .map((one) => ({
    ...one,
    source: "record" as const,
    llm: one.llm === 1,
    // A row that never said whether it attached takes the turn run's word where the log has one.
    attached: one.attached === null ? attachedAt(one.chatId, one.messageId)?.has(one.slug) ?? null : one.attached === 1,
  }));
const recordTurns = new Set(recordRows.map((one) => turnKey(one.chatId, one.messageId)));

// The classifier's runs, the last whole run of each message standing for it.
const classifierRuns = new Map<string, Partial<Record<"start" | "prompt" | "end", { text: string; truncated: number }>>>();

for (const one of db.query(`SELECT run, kind, text, truncated FROM agent_log WHERE agent = 'classifier'
    AND kind IN ('start', 'prompt', 'end') ORDER BY id`).all() as { run: string; kind: "start" | "prompt" | "end"; text: string; truncated: number }[]) {
  classifierRuns.set(one.run, { ...classifierRuns.get(one.run), [one.kind]: { text: one.text, truncated: one.truncated } });
}

const loggedRuns = new Map<string, LoggedClassifierRun>();

for (const run of classifierRuns.values()) {
  const named = /chat (-?\d+) · message (-?\d+)/.exec(run.start?.text ?? "");

  if (named === null || run.prompt === undefined || run.end === undefined) {
    continue;
  }

  const chatId = Number(named[1]);
  const messageId = Number(named[2]);

  loggedRuns.set(turnKey(chatId, messageId), {
    chatId, messageId, prompt: run.prompt.text, whole: run.prompt.truncated === 0, answer: run.end.text,
  });
}

const logRows: RecordedCandidate[] = [];
const logProbes: RecordedProbe[] = [];
const logSkipped: Record<LogSkip | "inRecord", number> = { cut: 0, failed: 0, noContext: 0, inRecord: 0 };

for (const [key, run] of loggedRuns) {
  if (recordTurns.has(key)) {
    logSkipped.inRecord += 1;
    continue;
  }

  const turn = classifierTurn(run, attachedAt(run.chatId, run.messageId));

  if (typeof turn === "string") {
    logSkipped[turn] += 1;
    continue;
  }

  logRows.push(...turn.candidates);
  logProbes.push(...turn.probes);
}

const reads: UseReads = {
  candidates: () => [...recordRows, ...logRows],
  probes: () => [...(db.query(`SELECT stage, chat_id AS chatId, message_id AS messageId, input FROM laya_verdicts
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
    }), ...logProbes],
  room: (chatId) => messagesIn(db, chatId),
  fragment: (chatId, slug) => {
    const row = db.query(`SELECT title, path FROM fragments WHERE slug = ?
        ORDER BY (chat_id = ?) DESC, (chat_id IS NULL) DESC, active DESC LIMIT 1`).get(slug, chatId) as
        { title: string; path: string } | null;

    return row === null ? null : { line: `${slug}: ${row.title}`, body: bodyAt(row.path) };
  },
};

const built = useTurns(reads, who);
const turns = limit === undefined ? built.turns : built.turns.slice(0, Number(limit));
const batches = join(root, "batches");

mkdirSync(batches, { recursive: true });

interface FrozenUse {
  turns: string[];
  answer: string;
  tokens: TokenTally;
  labels: Record<string, Record<string, UseLabel>>;
}

function readFrozen(): { file: string; one: FrozenUse }[] {
  return readdirSync(batches).filter((file) => /^\d+\.json$/.test(file)).sort()
    .map((file) => ({ file, one: JSON.parse(readFileSync(join(batches, file), "utf8")) as FrozenUse }));
}

// What earlier runs froze. A turn is judged once: a run taken up again, or run again after the
// record has grown, judges only the turns no frozen batch carries. A new batch takes a number past
// every one standing, so a batch that failed in an earlier run never leaves a number to be reused.
const frozenBefore = readFrozen();
const judged = new Set(frozenBefore.flatMap(({ one }) => one.turns));
const plan = useBatches(turns.filter((turn) => !judged.has(turn.id)));
const base = frozenBefore.reduce((highest, { file }) => Math.max(highest, Number(file.slice(0, -5)) + 1), 0);
const road = codexJudgeRoad({ model: codexModel, effort });
let failures = 0;
let spent: TokenTally = noTokens;

console.log(`턴 ${turns.length}개(세운 턴 ${built.turns.length}: 기록 ${built.turns.filter((turn) => turn.source === "record").length}, 로그 ${built.turns.filter((turn) => turn.source === "log").length}) · 빠진 턴: 답 없음 ${built.skipped.noReply}, 메시지 없음 ${built.skipped.noMessage}, 붙음 기록 없음 ${built.skipped.noAttachment}, 로그가 잘림 ${logSkipped.cut}, 분류기 실패 ${logSkipped.failed}, 턴 실행 기록 없음 ${logSkipped.noContext} · 굳은 묶음 ${frozenBefore.length}개 · 새 묶음 ${plan.length}개`);

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
    spent = addTokens(spent, answer.tokens);
    console.log(`묶음 ${at + 1}/${plan.length} 굳음`);
  } catch (error) {
    failures += 1;
    console.error(`묶음 ${at + 1}: ${(error as Error).message}`);
  }
}

for (let next = 0; next < plan.length; next += atOnce) {
  await Promise.all(plan.slice(next, next + atOnce).map((batch, at) => judge(batch, next + at)));
}

const frozen = readFrozen();

labelTurns(turns, new Map(frozen.flatMap(({ one }) => Object.entries(one.labels))
  .map(([id, kept]) => [id, new Map(Object.entries(kept))])));

// Laya asked again, turn by turn, as the server serves each gate now. An answer is kept beside the
// checkpoint that gave it and reused while that checkpoint still serves the gate.
const served = new Map<string, string | null>();

try {
  const health = await (await fetch(`${layaUrl}/health`, { headers: { authorization: `Bearer ${layaToken}` } })).json() as
    { gates?: Record<string, { model?: string }> };

  for (const [gate, one] of Object.entries(health.gates ?? {})) {
    served.set(gate, one.model ?? null);
  }
} catch (error) {
  console.error(`Laya 서버에 닿지 않았습니다 — ${(error as Error).message}`);
}

const layaFile = join(root, "laya.jsonl");
const answered = new Map<string, { model: string | null; answers: LayaAnswers }>();

for (const line of existsSync(layaFile) ? readFileSync(layaFile, "utf8").split("\n").filter((one) => one.trim() !== "") : []) {
  const said = JSON.parse(line) as { key: string; model?: string | null; answers: LayaAnswers };

  answered.set(said.key, { model: said.model ?? null, answers: said.answers });
}

let layaFailures = 0;
let layaAsked = 0;
let layaReused = 0;

// One decision, asked once more where the connection itself dropped: the server closes an idle
// connection the client may still be about to reuse, and that is not an answer about the turn.
async function askLaya(gate: UseGate, request: LayaRequest): Promise<LayaAnswers | null> {
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

// Every probe input of the turn asked, their answers read as one set; one input unanswered leaves
// the turn without an answer rather than with half of one.
async function askTurn(gate: UseGate, requests: readonly LayaRequest[]): Promise<LayaAnswers | null> {
  const merged: LayaAnswers = {};

  for (const request of requests) {
    const answers = await askLaya(gate, request);

    layaAsked += 1;

    if (answers === null) {
      return null;
    }

    Object.assign(merged, answers);
  }

  return merged;
}

const laya = new Map<string, LayaAnswers>();

// Gate by gate rather than turn by turn: the server keeps one checkpoint on the card, and asking
// the gates in turn would move a checkpoint onto it on every call.
for (const gate of useGates) {
  const model = served.get(gate);

  if (model === undefined) {
    continue;
  }

  for (const turn of turns) {
    const requests = turn.probes[gate] ?? [];
    const key = `${turn.id}/${gate}`;
    const kept = answered.get(key);

    if (requests.length === 0) {
      continue;
    }

    if (kept !== undefined && model !== null && kept.model === model) {
      layaReused += 1;
      laya.set(key, kept.answers);
      continue;
    }

    const answers = await askTurn(gate, requests);

    if (answers === null) {
      layaFailures += 1;
    } else {
      laya.set(key, answers);
      answered.set(key, { model, answers });
    }
  }
}

writeFileSync(join(root, "turns.jsonl"), turns.map((turn) => `${JSON.stringify({
  id: turn.id,
  source: turn.source,
  candidates: turn.candidates.map(({ gate, slug, llm, attached, bodyHash, label }) => ({ gate, slug, llm, attached, bodyHash, label })),
})}\n`).join(""));
writeFileSync(layaFile, [...answered].map(([key, one]) => `${JSON.stringify({ key, model: one.model, answers: one.answers })}\n`).join(""));

// The gate batches the curve reads: one for every judged batch, under its place in the run of
// judged batches, frozen once. A rehearsal run with --limit has not built every turn a batch
// carries, so it freezes none.
const byId = new Map(turns.map((turn) => [turn.id, turn]));

function gateBatches(gate: UseGate): void {
  const folder = gateFolder(root, gate);
  const outcome = trainingRows(gate, turns, shares);
  const held = readProgress(folder);

  frozen.forEach(({ one }, at) => {
    if (!existsSync(join(folder, "batches", `${gate}-${String(at + 1).padStart(4, "0")}.jsonl`))) {
      freezeBatch(folder, gate, at, trainingRows(gate, one.turns.flatMap((id) => byId.get(id) ?? []), shares).rows);
    }
  });

  const progress: SynthProgress = {
    started: held?.started ?? new Date().toISOString(),
    model: codexModel,
    effort,
    road: "codex",
    rows: turns.length,
    batchSize: turnsPerBatch,
    shares,
    gates: {
      [gate]: {
        done: frozen.length, sessionId: null, kept: outcome.rows.length, refused: outcome.refusals as Record<string, number>,
        unreadable: 0, lostBatches: 0, tokens: noTokens,
      },
    },
  };

  writeProgress(folder, progress);
}

if (limit === undefined) {
  for (const gate of useGates) {
    gateBatches(gate);
  }
}

const figures = useGates.map((gate) => gateFigures(gate, turns, laya));
const recordFigures = useGates.map((gate) => gateFigures(gate, turns.filter((turn) => turn.source === "record"), laya));
// One row an input, as the curve keeps them: two turns with the same messages offered the same
// candidates are one input.
const rows = Object.fromEntries(useGates.map((gate) => {
  const outcome = trainingRows(gate, turns, shares);
  const once = [...new Map(outcome.rows.map((one) => [one.row.id, one.row])).values()];

  return [gate, { ...answerCounts(once), refusals: outcome.refusals }];
}));
const tokens = frozen.reduce((sum, { one }) => addTokens(sum, one.tokens), noTokens);
const report = {
  written: new Date().toISOString(),
  model: codexModel,
  effort,
  served: Object.fromEntries(served),
  layaAsked,
  layaReused,
  layaFailures,
  turns: turns.length,
  sources: { record: turns.filter((turn) => turn.source === "record").length, log: turns.filter((turn) => turn.source === "log").length },
  skipped: { ...built.skipped, log: logSkipped },
  calls: frozen.length,
  failedBatches: failures,
  unjudgedTurns: turns.filter((turn) => !frozen.some(({ one }) => one.turns.includes(turn.id))).length,
  tokens,
  bar,
  gates: figures.map((one) => ({ ...one, clearing: clearingTau(one, bar) })),
  recordGates: recordFigures.map((one) => ({ ...one, clearing: clearingTau(one, bar) })),
  rows,
};

writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
appendFileSync(join(root, "ticks.jsonl"), `${JSON.stringify({
  at: report.written, turns: turns.length, newTurns: plan.reduce((sum, batch) => sum + batch.length, 0), calls: plan.length,
  failedBatches: failures, tokens: spent, layaAsked, layaReused, layaFailures,
})}\n`);
console.log(`${root}/report.json 에 썼어요.`);

for (const one of report.gates) {
  const cleared = one.clearing === null ? "못 넘음" : `τ ${one.clearing.tau} 에서 ${one.clearing.settled}턴`;
  const counted = rows[one.gate]!;

  console.log(`${one.gate.padEnd(18)} 턴 ${one.turns} · 붙임 ${one.attached} (씀 ${one.used} · 관련 ${one.related} · 안 씀 ${one.unused}) · 누락 턴 ${one.missTurns} · 행 ${counted.rows} (필요 ${counted.yes}문항, 필요 든 행 ${counted.rowsWithYes}) · Laya ${one.laya?.turns ?? 0}턴 · ${cleared}`);
}

process.exit(failures > 0 ? 1 : 0);
