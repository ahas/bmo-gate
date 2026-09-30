import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bmoIdFrom, messagesIn, openArchive, ownerIdFrom, roomsIn } from "../src/archive";
import { releaseArchiveCopy, takeArchiveCopy } from "../src/archive-copy";
import { allOf, asksUsage, asked, lastOf, readFlags } from "../src/flags";
import {
  cleanLine, embed, harvestLanguages, harvestPrompt, harvestSystem, liveLine, metaCategories, metaHarmTemplates,
  mightTrigger, modelCategories, normaliseSentence, overRefusalTemplates, sanitizerGate, sanitizerRow,
  securityAdjacentClean, sentenceOutcome,
} from "../src/laya-sanitize";
import { languageOf } from "../src/laya-synth";
import {
  addTokens, batchName, batchesFolder, freezeBatch, freezeByCategory, freezeSplits, guardFolder, noTokens,
  readProgress, writeProgress,
} from "../src/laya-synth-run";
import { TEXT_NODES, textHealthUrl } from "../src/n5-llm-install";
import { n5StreamerFor, n5TimeoutMs } from "../src/n5-road";
import { scrubText } from "../src/pii";
import { refuseInsideCheckout, runFolder } from "../src/roots";

import type { ArchivedMessage } from "../src/archive";
import type { HarmCategory, HarvestLanguage } from "../src/laya-sanitize";
import type { N5Streamer } from "../src/n5-road";
import type { FrozenRow, GateProgress, SynthProgress } from "../src/laya-synth-run";

// The 무해화 게이트's distilled data, built the way 하스 set (todo #1017, broadened in #1039): the
// uncensored text model writes only the dangerous sentences, one to a line, and the code makes the
// rows. The categories are the policy research's whole risk taxonomy (archive 129). Twelve are written
// by the model across n2 to n5 in parallel; two — child safety and sexually explicit content — are
// never written by any model and are built here from harmless meta-descriptions instead. A sentence a
// model wrote is harmful by construction and is embedded among ordinary lines; a text from the rooms'
// ordinary talk or from the over-refusal cases is clean by construction. Nothing here judges what the
// model wrote — the label is fixed by how the row is made — and nothing here reads the sentences for a
// person: they stream into a live file 하스 can watch, and the rows freeze into the run folder the
// training reads. Beside the combined splits each category's rows are written to a file of its own.
// The worker and BMO read neither the sentences nor the live file, only the counts and the paths.

const defaultRows = 7_500;
const defaultHarmfulShare = 0.5;
const defaultPerHarvest = 30;

const usage = `usage: bun scripts/laya-sanitize.ts --run <이름>
                                   [--rows <n>] [--harmful-share <0~1>] [--per-harvest <n>]
                                   [--node <n2|n3|n4|n5>]… [--calibration <비율>] [--test <비율>]
                                   [--db <경로>] [--owner <번호>] [--bmo <번호>] [--seed <씨앗>]
                                   [--timeout <초>] [--resume] [--overwrite]

무해화 게이트(sanitizer) 학습 데이터를 텍스트 모델로 짓는다. 모델은 위험한 문장만 한 줄에 하나씩 쓰고
(전부 유해), 코드가 실제 대화 맥락에 끼워 넣어 유해 행을 만든다. 아동·성적 콘텐츠 두 범주는 모델이
쓰지 않고 무해한 메타 서술로만 만든다. 무해 행은 모델이 만들지 않고 아카이브의 정상 메시지와 과잉
거절 사례로 채운다.
--run 은 런타임 데이터 뿌리 아래의 이름이거나 절대 경로다. 체크아웃 안에는 쓰지 않는다.
--node 는 생성에 쓸 텍스트 모델 노드다. 없으면 ${TEXT_NODES.join(", ")} 를 다 살펴 답하는 노드만 쓴다.
--rows 는 지을 행 수(기본 ${defaultRows}), --harmful-share 는 그중 유해 몫(기본 ${defaultHarmfulShare}).
--per-harvest 는 한 번에 받을 문장 수(기본 ${defaultPerHarvest}).
--db 는 읽을 아카이브 파일, 없으면 비모 아카이브의 사본을 새로 떠서 읽는다.
--seed 는 무해 표본과 맥락을 고르는 씨앗(기본 laya-sanitize).
--resume 은 쓰다 만 실행을 굳지 않은 묶음부터 이어 간다. --overwrite 는 폴더를 비우고 다시 쓴다.

생성되는 문장은 실행 폴더의 live.txt 에 도착하는 대로 쌓인다(범주·언어·채택여부·문장). tail -f 로 본다.
범주별 파일은 실행 폴더의 by-category/<범주>/ 아래에 학습·보정·시험으로 나뉜다.

백그라운드로 띄우려면:
  setsid bun scripts/laya-sanitize.ts --run <이름> </dev/null >/dev/null 2>&1 &`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--run": true, "--rows": true, "--harmful-share": true, "--per-harvest": true, "--node": true,
  "--calibration": true, "--test": true, "--db": true, "--owner": true, "--bmo": true, "--seed": true,
  "--timeout": true, "--resume": false, "--overwrite": false,
});

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-sanitize: ${reading.trouble ?? `${reading.loose.join(" ")} 는 무엇인지 모르겠습니다.`}`);
  console.error(usage);
  process.exit(2);
}

const named = lastOf(reading, "--run");

if (named === undefined) {
  console.error("laya-sanitize: 실행 이름을 --run 으로 주세요.");
  process.exit(2);
}

const root = runFolder(named);
const inside = refuseInsideCheckout(root);

if (inside !== null) {
  console.error(`laya-sanitize: ${inside}`);
  process.exit(2);
}

const rows = Number(lastOf(reading, "--rows") ?? String(defaultRows));
const harmfulShare = Number(lastOf(reading, "--harmful-share") ?? String(defaultHarmfulShare));
const perHarvest = Number(lastOf(reading, "--per-harvest") ?? String(defaultPerHarvest));
const shares = {
  calibration: Number(lastOf(reading, "--calibration") ?? "0.15"),
  test: Number(lastOf(reading, "--test") ?? "0.15"),
};
const timeoutMs = Number(lastOf(reading, "--timeout") ?? String(n5TimeoutMs / 1000)) * 1000;
const seed = lastOf(reading, "--seed") ?? "laya-sanitize";
const resume = asked(reading, "--resume");
const overwrite = asked(reading, "--overwrite");

const wantedNodes = allOf(reading, "--node");
const badNode = wantedNodes.find((node) => !(TEXT_NODES as readonly string[]).includes(node));

if (badNode !== undefined) {
  console.error(`laya-sanitize: ${badNode} 는 텍스트 모델 노드가 아니에요 (${TEXT_NODES.join(", ")}).`);
  process.exit(2);
}

const candidateNodes = wantedNodes.length > 0 ? wantedNodes : [...TEXT_NODES];

for (const [what, value] of [["--rows", rows], ["--per-harvest", perHarvest], ["--timeout", timeoutMs]] as const) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`laya-sanitize: ${what} 는 0보다 큰 수여야 합니다.`);
    process.exit(2);
  }
}

if (!Number.isFinite(harmfulShare) || harmfulShare <= 0 || harmfulShare >= 1) {
  console.error("laya-sanitize: --harmful-share 는 0과 1 사이여야 합니다.");
  process.exit(2);
}

mkdirSync(root, { recursive: true });

const guard = guardFolder(root, { resume, overwrite });

if (guard !== null) {
  console.error(`laya-sanitize: ${guard}`);
  process.exit(2);
}

const logPath = join(root, "run.log");
const livePath = join(root, "live.txt");

function say(line: string): void {
  console.log(line);
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

// The live file 하스 watches. A sentence body is written here and nowhere the worker reads; the
// header names the columns so a tail is legible on its own.
if (!existsSync(livePath)) {
  appendFileSync(livePath, "# category\tlanguage\taccepted|dropped:reason\tsentence\n");
}

function live(line: string): void {
  appendFileSync(livePath, `${line}\n`);
}

function trouble(cause: unknown): string {
  return cause instanceof Error ? (cause.message.split("\n")[0] ?? cause.message) : String(cause);
}

// Which of the wanted nodes answer their health right now, and why the rest are left out. A node whose
// front is not up cannot serve the model, so the run goes on with the ones that answered and names the
// ones it dropped (todo #1039: 되는 노드만으로 생성하고 어느 노드가 왜 빠졌는지 보고).
async function readyNodes(candidates: readonly string[]): Promise<{ ready: string[]; dropped: Array<[string, string]> }> {
  const ready: string[] = [];
  const dropped: Array<[string, string]> = [];

  for (const node of candidates) {
    try {
      const answered = await fetch(textHealthUrl(node), { signal: AbortSignal.timeout(8_000) });

      if (answered.status === 200) {
        ready.push(node);
      } else {
        dropped.push([node, `health ${answered.status}`]);
      }
    } catch (cause) {
      dropped.push([node, trouble(cause)]);
    }
  }

  return { ready, dropped };
}

const { ready: nodes, dropped } = await readyNodes(candidateNodes);

for (const [node, why] of dropped) {
  say(`노드 ${node} 는 빠집니다: ${why}`);
}

if (nodes.length === 0) {
  console.error(`laya-sanitize: 쓸 수 있는 텍스트 모델 노드가 없어요 (살펴본 노드: ${candidateNodes.join(", ")}). 먼저 bun scripts/n5-llm-install.ts 로 세우세요.`);
  process.exit(1);
}

say(`유해 문장 생성 노드: ${nodes.join(", ")}${dropped.length > 0 ? ` (${dropped.length}대 빠짐)` : ""}`);

const streamers = new Map<string, N5Streamer>(nodes.map((node) => [node, n5StreamerFor(node, { timeoutMs })]));

const harmfulTarget = Math.max(1, Math.round(rows * harmfulShare));

// Every category, model and meta, in each harvest language. The model groups come first so their batch
// indices sit together; the meta groups, built here without a model, follow. Every group gets the same
// number of harvests, so the categories come out near even.
interface Group {
  gi: number;
  category: HarmCategory;
  language: HarvestLanguage;
  meta: boolean;
}

const modelGroupsRaw = modelCategories().flatMap((category) => harvestLanguages.map((language) => ({ category, language, meta: false })));
const metaGroupsRaw = metaCategories().flatMap((category) => harvestLanguages.map((language) => ({ category, language, meta: true })));
const groups: Group[] = [...modelGroupsRaw, ...metaGroupsRaw].map((one, gi) => ({ ...one, gi }));

const harvestsPerGroup = Math.max(1, Math.ceil(harmfulTarget / (groups.length * perHarvest)));
// The harmful floor is the groups times the harvest size times the harvests each, often past the
// nominal target; the clean side is drawn to that floor so the two labels come out near even.
const harmfulPlanned = groups.length * harvestsPerGroup * perHarvest;
const cleanTarget = harmfulPlanned;
const genBatches = groups.length * harvestsPerGroup;
const cleanBatches = Math.ceil(cleanTarget / perHarvest);
const planLength = genBatches + cleanBatches;

// A file named is read as it stands; otherwise a copy of BMO's archive is taken for this run and the
// live one is never opened (docs/gate-data.md, 「The archive copy」).
const dbNamed = lastOf(reading, "--db");
const copy = dbNamed === undefined ? takeArchiveCopy() : null;

if (copy !== null) {
  process.on("exit", () => releaseArchiveCopy(copy));
}

const db = openArchive(dbNamed ?? copy!.path);
const ownerId = Number(lastOf(reading, "--owner") ?? ownerIdFrom());
const bmoId = Number(lastOf(reading, "--bmo") ?? bmoIdFrom());

// The ordinary, harmless lines the rooms give: contexts to embed a harmful sentence in, and the clean
// side's bulk. A message with an attack word in it is left out of both, since a harmful order hiding in
// a room's talk would be mislabelled clean.
function benignLines(want: number): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const { chatId } of roomsIn(db)) {
    if (kept.length >= want) {
      break;
    }

    for (const message of messagesIn(db, chatId) as ArchivedMessage[]) {
      if (kept.length >= want) {
        break;
      }

      if (message.senderId === bmoId || typeof message.text !== "string") {
        continue;
      }

      const text = scrubText(message.text).trim();

      if (text.length < 10 || text.length > 400 || mightTrigger(text)) {
        continue;
      }

      const key = normaliseSentence(text);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      kept.push(text);
    }
  }

  return kept;
}

// One deterministic pick out of a pool, by a counter, so a resumed run embeds the same sentence in the
// same context it did before.
function pick<T>(pool: readonly T[], at: number): T {
  return pool[((at % pool.length) + pool.length) % pool.length]!;
}

const benign = benignLines(Math.max(cleanTarget, harmfulTarget) + 200);
say(`아카이브에서 무해 문장 ${benign.length}개를 읽었습니다.`);
say(`owner ${ownerId}, bmo ${bmoId}.`);

// The clean rows, built once and deterministically: the security-adjacent over-refusal cases, then the
// fixed over-refusal lines, then the rooms' ordinary talk. Duplicates collapse when the rows freeze.
function cleanTexts(): string[] {
  const texts = [...securityAdjacentClean(seed, cleanTarget), ...overRefusalTemplates];

  for (let at = 0; texts.length < cleanTarget && at < benign.length; at += 1) {
    texts.push(benign[at]!);
  }

  return texts.slice(0, cleanTarget);
}

const started = Date.now();
const progress: SynthProgress = readProgress(root) ?? {
  started: new Date().toISOString(),
  model: "RVN-Q4_K_M-multilingual-mtp",
  effort: "none",
  road: "n5",
  roads: ["n5"],
  rows,
  batchSize: perHarvest,
  shares,
  gates: {},
};

const state: GateProgress = progress.gates[sanitizerGate] ?? { done: 0, sessionId: null, kept: 0, refused: {}, unreadable: 0, lostBatches: 0, tokens: noTokens };

progress.gates[sanitizerGate] = state;

function batchPath(index: number): string {
  return join(root, batchesFolder, batchName(sanitizerGate, index));
}

function isFrozen(index: number): boolean {
  return existsSync(batchPath(index));
}

function batchRowCount(index: number): number {
  return readFileSync(batchPath(index), "utf8").split("\n").filter((line) => line.trim() !== "").length;
}

// On resume, the kept and done counts are read back off the batches already on disk, since the run may
// have died between freezing a batch and writing that it did.
if (resume) {
  let kept = 0;
  let done = 0;

  for (let index = 0; index < planLength; index += 1) {
    if (isFrozen(index)) {
      kept += batchRowCount(index);
      done += 1;
    }
  }

  state.kept = kept;
  state.done = done;

  if (done > 0) {
    say(`이미 ${done}묶음 ${kept}행이 굳어 있어 굳지 않은 묶음만 채웁니다.`);
  }
}

say(`${root}: 유해 계획 ${harmfulPlanned}행(목표 ${harmfulTarget}), 무해 ${cleanTarget}행. 범주×언어 ${groups.length}묶음(모델 ${modelGroupsRaw.length}, 메타 ${metaGroupsRaw.length}), 묶음마다 수확 ${harvestsPerGroup}회, 한 수확 ${perHarvest}문장.`);
say(`모델 RVN-Q4_K_M-multilingual-mtp, 노드 ${nodes.join(", ")}. live.txt 에 문장이 쌓입니다.`);

// A run of accepted sentences a harvest streamed, read out line by line as they arrive on the given
// node's streamer: each line is cleaned, judged against the language and the shape, written to the live
// file with its verdict, and kept when it passes.
async function harvest(streamer: N5Streamer, category: HarmCategory, language: HarvestLanguage, kept: Set<string>, index: number): Promise<{ sentences: string[]; tokens: typeof noTokens }> {
  const accepted: string[] = [];
  let buffer = "";

  function take(line: string): void {
    const sentence = cleanLine(line);

    if (sentence === "") {
      return;
    }

    const outcome = sentenceOutcome(sentence, language, kept);

    live(liveLine(category.key, language, sentence, outcome));

    if (outcome.ok) {
      kept.add(normaliseSentence(sentence));
      accepted.push(sentence);
    } else if (outcome.reason !== undefined) {
      state.refused[outcome.reason] = (state.refused[outcome.reason] ?? 0) + 1;
    }
  }

  const prompt = harvestPrompt(category, language, perHarvest, `${seed}-${category.key}-${language}-${index}`);
  const answer = await streamer.stream(harvestSystem(), prompt, (delta) => {
    buffer += delta;

    let cut = buffer.indexOf("\n");

    while (cut >= 0) {
      take(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
    }
  });

  take(buffer);

  return { sentences: accepted, tokens: answer.tokens };
}

// A harvested (or meta) sentence made into a harmful row: a third stand bare as a short order, the rest
// are hidden among a few of the rooms' ordinary lines, which is where the gate really meets them. The
// language is read off the assembled text, so an order in one language among lines of the other reads
// mixed. Every row carries its category so it can be split out afterwards.
function harmfulRows(category: HarmCategory, sentences: readonly string[], index: number): FrozenRow[] {
  return sentences.map((sentence, at) => {
    const bare = at % 3 === 0 || benign.length === 0;
    const context = bare ? [] : [pick(benign, index * 7 + at), pick(benign, index * 13 + at + 1)];
    const place = bare ? -1 : (index + at) % (context.length + 1);
    const assembled = embed(sentence, context, place);

    return { row: sanitizerRow(assembled, true, shares), language: languageOf(assembled), category: category.key };
  });
}

// A meta category's sentences for one harvest: the harmless meta-descriptions for its language, cycled
// to the harvest size. No model is asked; the descriptions are fixed in the code. They stream to the
// live file the same as a harvested sentence, so 하스 sees they are meta.
function metaSentences(category: HarmCategory, language: HarvestLanguage): string[] {
  const templates = (metaHarmTemplates[category.key] ?? []).filter((one) => languageOf(one) === language);

  if (templates.length === 0) {
    return [];
  }

  const out: string[] = [];

  for (let at = 0; at < perHarvest; at += 1) {
    const sentence = templates[at % templates.length]!;

    out.push(sentence);
    live(liveLine(category.key, language, sentence, { ok: true }));
  }

  return out;
}

function freezeGen(index: number, frozen: readonly FrozenRow[]): void {
  state.kept += frozen.length;
  freezeBatch(root, sanitizerGate, index, frozen);
  writeProgress(root, progress);
}

class NodeFailed extends Error {
  constructor(public readonly node: string, public readonly group: Group, cause: unknown) {
    super(trouble(cause));
  }
}

// One node's share of the model groups, run one harvest at a time so a group's kept set is never
// touched by two harvests at once. A harvest the front will not answer throws, which ends this node's
// run; its unfinished groups are picked up by a later --resume.
async function runNode(node: string, mine: readonly Group[]): Promise<void> {
  const streamer = streamers.get(node)!;

  for (const group of mine) {
    const kept = new Set<string>();

    for (let h = 0; h < harvestsPerGroup; h += 1) {
      const index = group.gi * harvestsPerGroup + h;

      if (isFrozen(index)) {
        continue;
      }

      let got: { sentences: string[]; tokens: typeof noTokens };

      try {
        got = await harvest(streamer, group.category, group.language, kept, index);
      } catch (cause) {
        throw new NodeFailed(node, group, cause);
      }

      const frozen = harmfulRows(group.category, got.sentences, index);

      state.tokens = addTokens(state.tokens, got.tokens);
      freezeGen(index, frozen);
      say(`유해 ${group.category.key}/${group.language} ${h + 1}/${harvestsPerGroup} (${node}): ${got.sentences.length}문장 → ${frozen.length}행 (지금까지 ${state.kept}행)`);
    }
  }
}

// The model groups dealt out across the ready nodes round-robin, each node running its own in parallel.
const modelGroups = groups.filter((group) => !group.meta);
const byNode = new Map<string, Group[]>(nodes.map((node) => [node, []]));

modelGroups.forEach((group, at) => {
  byNode.get(nodes[at % nodes.length]!)!.push(group);
});

const ran = await Promise.allSettled(nodes.map((node) => runNode(node, byNode.get(node)!)));
const nodeFailures = ran.flatMap((one) => one.status === "rejected" ? [one.reason as NodeFailed] : []);

for (const failure of nodeFailures) {
  say(`노드 ${failure.node} 중단: ${failure.group.category.key}/${failure.group.language} 수확 실패 — ${failure.message}. --resume 으로 이어 가세요.`);
}

// The meta groups, built here with no model, after the model harvests.
for (const group of groups.filter((group) => group.meta)) {
  for (let h = 0; h < harvestsPerGroup; h += 1) {
    const index = group.gi * harvestsPerGroup + h;

    if (isFrozen(index)) {
      continue;
    }

    const sentences = metaSentences(group.category, group.language);
    const frozen = harmfulRows(group.category, sentences, index);

    freezeGen(index, frozen);
    say(`유해(메타) ${group.category.key}/${group.language} ${h + 1}/${harvestsPerGroup}: ${frozen.length}행 (지금까지 ${state.kept}행)`);
  }
}

// The clean batches: built with no model, chunked and frozen after the harmful ones. A clean row's
// category tells the over-refusal cases (which carry attack words) apart from ordinary talk.
const clean = cleanTexts();
const cleanWithTrigger = clean.filter((text) => mightTrigger(text)).length;

for (let at = 0; at < clean.length; at += perHarvest) {
  const index = genBatches + Math.floor(at / perHarvest);

  if (isFrozen(index)) {
    continue;
  }

  const frozen: FrozenRow[] = clean.slice(at, at + perHarvest).map((text) => ({
    row: sanitizerRow(text, false, shares),
    language: languageOf(text),
    category: mightTrigger(text) ? "clean-adjacent" : "clean-ordinary",
  }));

  freezeGen(index, frozen);
  say(`무해 ${Math.floor(at / perHarvest) + 1}/${Math.ceil(clean.length / perHarvest)}: ${frozen.length}행 굳힘 (지금까지 ${state.kept}행)`);
}

const unfrozen: number[] = [];

for (let index = 0; index < planLength; index += 1) {
  if (!isFrozen(index)) {
    unfrozen.push(index);
  }
}

state.done = planLength - unfrozen.length;

const meta = freezeSplits(root, progress);
const categoryFigures = freezeByCategory(root);
const figures = meta.gates.find((one) => one.gate === sanitizerGate);

say("");
say(`${Math.round((Date.now() - started) / 1000)}초 걸렸습니다.`);

if (unfrozen.length > 0) {
  say(`아직 굳지 않은 묶음 ${unfrozen.length}개가 있어요 (노드 실패). --resume 으로 이어 가세요.`);
}

if (figures !== undefined) {
  say(`무해화 게이트: ${figures.rows}행 (학습 ${figures.splits.train} · 보정 ${figures.splits.calibration} · 시험 ${figures.splits.test})`);
  say(`  라벨: 유해(DEFUSE) ${figures.balance.true ?? 0} · 무해(CLEAN) ${figures.balance.false ?? 0} (비율)`);
  say(`  언어: 한국어 ${figures.language.korean} · 영어 ${figures.language.english} · 섞임 ${figures.language.mixed} (비율)`);
  say(`  무해 중 공격 어휘를 담고도 CLEAN 인 행: ${cleanWithTrigger}`);
  say(`  버린 문장(수확 기준): ${Object.entries(state.refused).map(([why, n]) => `${why} ${n}`).join(" · ") || "기록 없음"}`);
  say(`  토큰: 입력 ${figures.tokens.inputTokens} · 출력 ${figures.tokens.outputTokens}`);
}

say(`범주별 (${categoryFigures.length}개):`);

for (const one of categoryFigures) {
  say(`  ${one.category}: ${one.rows}행 (학습 ${one.splits.train} · 보정 ${one.splits.calibration} · 시험 ${one.splits.test}; 한 ${one.language.korean} · 영 ${one.language.english} · 섞 ${one.language.mixed})`);
}

say(`live.txt: ${livePath}`);
say(`by-category: ${join(root, "by-category")}`);

if (unfrozen.length > 0) {
  process.exit(1);
}
