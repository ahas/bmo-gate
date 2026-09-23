import { allOf, asksUsage, lastOf, readFlags } from "../src/flags";
import { refuseOverwrite } from "../src/laya-frozen";
import { buildRehearsal, rehearsalLines } from "../src/laya-rehearsal";
import { gateSyntheses } from "../src/laya-synth";
import { dataPath, refuseInsideCheckout } from "../src/roots";

// The rehearsal dataset the training machinery is put through its paces on
// (docs/laya-train-run.md, 「The data it trains on」): the ten gates' three splits, written here with
// no model asked and no archive read, every row marked as a rehearsal.
//
// It is not training data and no figure measured on it is a gate's. What it is for is the resume,
// the driver, the collection and the tables — so all of them are seen working before the distilled
// data is paid for.
//
// usage: bun scripts/laya-rehearsal.ts --out <폴더> [--rows <n>] [--seed <n>] [--gate <게이트>]… [--overwrite]

const usage = `usage: bun scripts/laya-rehearsal.ts --out <폴더> [--rows <n>] [--seed <n>] [--gate <게이트>]… [--overwrite]

게이트 열 개의 리허설 데이터를 짓는다. 모델을 부르지 않고 아카이브도 읽지 않으며, 게이트마다
제 규격의 예시 행을 흔들어 만들고 그 게이트의 검사기에 그대로 통과시킨다.
행마다 리허설 표시가 붙고, 폴더에도 표시가 남는다. 이 데이터로 잰 수치는 증거가 아니다.
--out 이 /로 시작하지 않으면 런타임 데이터 뿌리 아래 laya-rehearsal/<이름> 에 쓴다.
--rows 는 게이트마다 몇 행부터 시작할지다(기본 60). 세 분할이 저마다 찰 때까지 늘어난다.
--seed 는 같은 씨앗이면 같은 데이터가 나오게 하는 값이다(기본 713).
--gate 없이는 열 게이트를 모두 짓는다: ${gateSyntheses.map((one) => one.gate).join(", ")}
이미 굳은 폴더는 --overwrite 없이는 덮지 않는다.`;

const argv = process.argv.slice(2);

if (asksUsage(argv)) {
  console.log(usage);
  process.exit(0);
}

const reading = readFlags(argv, { "--out": true, "--rows": true, "--seed": true, "--gate": true, "--overwrite": false });

if (!reading.ok || reading.loose.length > 0) {
  console.error(`laya-rehearsal: ${reading.trouble ?? `옵션이 아닌 인자가 있어요 — ${reading.loose.join(" ")}`}`);
  console.error(usage);
  process.exit(2);
}

const value = (flag: string) => lastOf(reading, flag) ?? null;
const out = value("--out");

if (out === null) {
  console.error("laya-rehearsal: 쓸 폴더를 --out 으로 주세요.");
  console.error(usage);
  process.exit(2);
}

const folder = out.startsWith("/") ? out : dataPath("laya-rehearsal", out);

const inside = refuseInsideCheckout(folder);

if (inside !== null) {
  console.error(inside);
  process.exit(2);
}

const refusal = refuseOverwrite(folder, argv.includes("--overwrite"));

if (refusal !== null) {
  console.error(refusal);
  process.exit(1);
}

const counted = (flag: string, fallback: number) => {
  const said = value(flag);

  return said === null ? fallback : Number(said);
};
const rows = counted("--rows", 60);
const seed = counted("--seed", 713);

if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(seed)) {
  console.error("laya-rehearsal: --rows 는 1 이상의 정수, --seed 는 정수예요.");
  process.exit(2);
}

const built = buildRehearsal({
  folder,
  gates: allOf(reading, "--gate"),
  rows,
  seed,
});

if (typeof built === "string") {
  console.error(`laya-rehearsal: ${built}`);
  process.exit(1);
}

console.log(`${folder} 에 썼어요.`);
console.log(rehearsalLines(built).join("\n"));
