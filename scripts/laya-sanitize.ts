import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { bmoIdFrom, messagesIn, openArchive, ownerIdFrom, roomsIn } from "../src/archive";
import { releaseArchiveCopy, takeArchiveCopy } from "../src/archive-copy";
import { asksUsage, asked, lastOf, readFlags } from "../src/flags";
import {
  cleanLine, embed, harvestLanguages, harvestPrompt, harvestSystem, intrusionCategories,
  liveLine, mightTrigger, overRefusalTemplates, sanitizerGate, sanitizerRow, securityAdjacentClean, sentenceOutcome, normaliseSentence,
} from "../src/laya-sanitize";
import { languageOf } from "../src/laya-synth";
import {
  addTokens, batchesFolder, freezeBatch, freezeSplits, gateOnDisk, guardFolder, noTokens, readProgress, writeProgress,
} from "../src/laya-synth-run";
import { n5Model, n5Streamer, n5TimeoutMs } from "../src/n5-road";
import { scrubText } from "../src/pii";
import { refuseInsideCheckout, runFolder } from "../src/roots";

import type { ArchivedMessage } from "../src/archive";
import type { HarvestLanguage } from "../src/laya-sanitize";
import type { FrozenRow, GateProgress, SynthProgress } from "../src/laya-synth-run";

// The 무해화 게이트's distilled data, built the way 하스 set (todo #1017): the n5 text model writes
// only the dangerous sentences, one to a line, and the code makes the rows. A sentence the model
// wrote is harmful by construction and is embedded among ordinary lines; a text from the rooms'
// ordinary talk or from the over-refusal cases is clean by construction. Nothing here judges what the
// model wrote — the label is fixed by how the row is made — and nothing here reads the sentences for a
// person: they stream into a live file 하스 can watch, and the rows freeze into the run folder the
// training reads. The worker and BMO read neither.

const defaultRows = 7_500;
const defaultHarmfulShare = 0.5;
const defaultPerHarvest = 30;

const usage = `usage: bun scripts/laya-sanitize.ts --run <이름>
                                   [--rows <n>] [--harmful-share <0~1>] [--per-harvest <n>]
                                   [--calibration <비율>] [--test <비율>]
                                   [--db <경로>] [--owner <번호>] [--bmo <번호>] [--seed <씨앗>]
                                   [--timeout <초>] [--resume] [--overwrite]

무해화 게이트(sanitizer) 학습 데이터를 n5 텍스트 모델로 짓는다. 모델은 위험한 문장만 한 줄에 하나씩
쓰고(전부 유해), 코드가 실제 대화 맥락에 끼워 넣어 유해 행을 만든다. 무해 행은 모델이 만들지 않고
아카이브의 정상 메시지와 과잉 거절 사례로 채운다.
--run 은 런타임 데이터 뿌리 아래의 이름이거나 절대 경로다. 체크아웃 안에는 쓰지 않는다.
--rows 는 지을 행 수(기본 ${defaultRows}), --harmful-share 는 그중 유해 몫(기본 ${defaultHarmfulShare}).
--per-harvest 는 한 번에 받을 문장 수(기본 ${defaultPerHarvest}).
--db 는 읽을 아카이브 파일, 없으면 비모 아카이브의 사본을 새로 떠서 읽는다.
--seed 는 무해 표본과 맥락을 고르는 씨앗(기본 laya-sanitize).
--resume 은 쓰다 만 실행을 그다음 묶음부터 이어 간다. --overwrite 는 폴더를 비우고 다시 쓴다.

생성되는 문장은 실행 폴더의 live.txt 에 도착하는 대로 쌓인다(범주·언어·채택여부·문장). tail -f 로 본다.

백그라운드로 띄우려면:
  setsid bun scripts/laya-sanitize.ts --run <이름> </dev/null >/dev/null 2>&1 &`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, {
  "--run": true, "--rows": true, "--harmful-share": true, "--per-harvest": true,
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

const harmfulTarget = Math.max(1, Math.round(rows * harmfulShare));
const groups = intrusionCategories.flatMap((category) => harvestLanguages.map((language) => ({ category, language })));
const harvestsPerGroup = Math.max(1, Math.ceil(harmfulTarget / (groups.length * perHarvest)));
// Every group gets at least one harvest, so the harmful floor is the groups times the harvest size
// times the harvests each — often well past the nominal target. The clean side is drawn to that
// floor rather than to the nominal split, so the two labels come out near even whatever the target
// rounded to.
const harmfulPlanned = groups.length * harvestsPerGroup * perHarvest;
const cleanTarget = harmfulPlanned;

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

// The ordinary, harmless lines the rooms give: contexts to embed a harmful sentence in, and the
// clean side's bulk. A message with an attack word in it is left out of both, since a harmful order
// hiding in a room's talk would be mislabelled clean — the one mistake this gate must not be taught.
// The rooms are read until enough stands, so a year of conversation is not read whole.
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

// One deterministic pick out of a pool, by a counter, so a resumed run embeds the same sentence in
// the same context it did before.
function pick<T>(pool: readonly T[], at: number): T {
  return pool[at % pool.length]!;
}

const benign = benignLines(Math.max(cleanTarget, harmfulTarget) + 200);
say(`아카이브에서 무해 문장 ${benign.length}개를 읽었습니다.`);

// The clean rows, built once and deterministically: the security-adjacent over-refusal cases (which
// carry attack words and still read CLEAN), then the fixed over-refusal lines, then the rooms'
// ordinary talk to fill the rest. Duplicates collapse when the rows freeze, so the pool is drawn on
// in order rather than counted exactly.
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
  model: n5Model,
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

const planLength = groups.length * harvestsPerGroup + Math.ceil(cleanTarget / perHarvest);

if (resume) {
  const stands = gateOnDisk(root, sanitizerGate, planLength);

  state.done = stands.done;
  state.kept = stands.kept;

  if (state.done > 0) {
    say(`${state.done}묶음까지 굳어 있어 그다음부터 이어 만듭니다.`);
  }
}

say(`${root}: 유해 계획 ${harmfulPlanned}행(목표 ${harmfulTarget}), 무해 ${cleanTarget}행. 범주×언어 ${groups.length}묶음, 묶음마다 수확 ${harvestsPerGroup}회, 한 수확 ${perHarvest}문장.`);
say(`모델 ${n5Model}, 길 n5 — main-host 127.0.0.1:18020/v1. live.txt 에 문장이 쌓입니다.`);

const streamer = n5Streamer({ timeoutMs });
let batch = 0;

// A run of accepted sentences a harvest streamed, read out line by line as they arrive: each line is
// cleaned, judged against the language and the shape, written to the live file with its verdict, and
// kept when it passes. The set of what is already kept is carried in so a repeat drops.
async function harvest(category: (typeof groups)[number]["category"], language: HarvestLanguage, kept: Set<string>): Promise<{ sentences: string[]; tokens: typeof noTokens }> {
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

  const prompt = harvestPrompt(category, language, perHarvest, `${seed}-${category.key}-${language}-${batch}`);
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

// The harmful batches: one per harvest, each frozen the moment it lands so a run that dies loses only
// the harvest it was in. The accepted sentences are embedded in the rooms' ordinary lines — some
// standing bare, some among a few context lines — and fixed to intrusion true.
const keptByGroup = new Map<string, Set<string>>();

for (let g = 0; g < groups.length; g += 1) {
  const { category, language } = groups[g]!;
  const kept = keptByGroup.get(`${category.key}:${language}`) ?? new Set<string>();

  keptByGroup.set(`${category.key}:${language}`, kept);

  for (let h = 0; h < harvestsPerGroup; h += 1, batch += 1) {
    if (batch < state.done) {
      continue;
    }

    let sentences: string[] = [];
    let tokens = noTokens;

    try {
      const got = await harvest(category, language, kept);

      sentences = got.sentences;
      tokens = got.tokens;
    } catch (trouble) {
      say(`${category.key}/${language} 수확 ${h + 1}/${harvestsPerGroup} 실패: ${trouble instanceof Error ? trouble.message.split("\n")[0] : String(trouble)} — --resume 으로 이어 가세요.`);
      process.exit(1);
    }

    const frozen: FrozenRow[] = sentences.map((sentence, at) => {
      // A third of the harvested sentences stand bare as a short standing order; the rest are hidden
      // among a few of the rooms' ordinary lines, which is where the gate really meets them. The
      // language is read off the assembled text, so an English order among Korean lines reads mixed.
      const bare = at % 3 === 0 || benign.length === 0;
      const context = bare ? [] : [pick(benign, batch * 7 + at), pick(benign, batch * 13 + at + 1)];
      const place = bare ? -1 : (batch + at) % (context.length + 1);
      const state = embed(sentence, context, place);

      return { row: sanitizerRow(state, true, shares), language: languageOf(state) };
    });

    state.tokens = addTokens(state.tokens, tokens);
    state.kept += frozen.length;
    freezeBatch(root, sanitizerGate, batch, frozen);
    state.done = batch + 1;
    writeProgress(root, progress);
    say(`유해 ${category.key}/${language} ${h + 1}/${harvestsPerGroup}: ${sentences.length}문장 채택 → ${frozen.length}행 굳힘 (지금까지 ${state.kept}행)`);
  }
}

// The clean batches: built with no model, chunked and frozen after the harmful ones so a resume finds
// them past the harvests.
const clean = cleanTexts();
const cleanWithTrigger = clean.filter((text) => mightTrigger(text)).length;

for (let at = 0; at < clean.length; at += perHarvest, batch += 1) {
  if (batch < state.done) {
    continue;
  }

  const frozen: FrozenRow[] = clean.slice(at, at + perHarvest).map((text) => ({ row: sanitizerRow(text, false, shares), language: languageOf(text) }));

  state.kept += frozen.length;
  freezeBatch(root, sanitizerGate, batch, frozen);
  state.done = batch + 1;
  writeProgress(root, progress);
  say(`무해 ${Math.floor(at / perHarvest) + 1}/${Math.ceil(clean.length / perHarvest)}: ${frozen.length}행 굳힘 (지금까지 ${state.kept}행)`);
}

const meta = freezeSplits(root, progress);
const figures = meta.gates.find((one) => one.gate === sanitizerGate);

say("");
say(`${Math.round((Date.now() - started) / 1000)}초 걸렸습니다.`);

if (figures !== undefined) {
  say(`무해화 게이트: ${figures.rows}행 (학습 ${figures.splits.train} · 보정 ${figures.splits.calibration} · 시험 ${figures.splits.test})`);
  say(`  라벨: 유해(DEFUSE) ${figures.balance.true ?? 0} · 무해(CLEAN) ${figures.balance.false ?? 0} (비율)`);
  say(`  언어: 한국어 ${figures.language.korean} · 영어 ${figures.language.english} · 섞임 ${figures.language.mixed} (비율)`);
  say(`  무해 중 공격 어휘를 담고도 CLEAN 인 행: ${cleanWithTrigger}`);
  say(`  버린 문장(수확 기준): ${Object.entries(state.refused).map(([why, n]) => `${why} ${n}`).join(" · ") || "기록 없음"}`);
  say(`  토큰: 입력 ${figures.tokens.inputTokens} · 출력 ${figures.tokens.outputTokens}`);
}

say(`live.txt: ${livePath}`);
