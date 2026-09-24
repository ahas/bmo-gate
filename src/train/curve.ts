import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { laidOut } from "./table";

// The curve a source's gates draw as they are trained again and again (docs/training.md, 「The ledger
// and the curve」): one point a gate a pass, appended and never rewritten, with the ids the point was
// trained on kept beside it for the next pass to count its new rows against.

export const curveFile = "curve.jsonl";
export const idsFolder = "ids";

export interface CurvePoint {
  pass: number;
  at: string;
  // The source's name and the training run the pass was on the nodes as.
  run: string;
  training: string;
  gate: string;
  // What sets one run of the gate's rows apart from a run started over, where the source has one.
  started: string;
  rows: number;
  train: number;
  calibration: number;
  test: number;
  // The digest of the rows trained on; absent on points made before rows were digested.
  digest?: string;
  node: string | null;
  state: "done" | "failed" | "unreachable";
  agreement: number | null;
  balanced: number | null;
  ece: number | null;
  seconds: number | null;
  fault: string | null;
}

export function readCurve(folder: string): CurvePoint[] {
  const path = join(folder, curveFile);

  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
    try {
      return [JSON.parse(line) as CurvePoint];
    } catch {
      return [];
    }
  });
}

// A pass's points in one write, and each point's ids beside it.
export function appendCurve(folder: string, points: readonly { point: CurvePoint; ids: readonly string[] }[]): void {
  if (points.length === 0) {
    return;
  }

  mkdirSync(join(folder, idsFolder), { recursive: true });

  for (const { point, ids } of points) {
    writeFileSync(idsPath(folder, point), `${JSON.stringify(ids)}\n`);
  }

  appendFileSync(join(folder, curveFile), points.map(({ point }) => `${JSON.stringify(point)}\n`).join(""));
}

function idsPath(folder: string, point: Pick<CurvePoint, "pass" | "gate">): string {
  return join(folder, idsFolder, `${String(point.pass).padStart(4, "0")}-${point.gate}.json`);
}

// The ids a point was trained on, or null for a point made before they were kept.
export function pointIds(folder: string, point: Pick<CurvePoint, "pass" | "gate">): Set<string> | null {
  const path = idsPath(folder, point);

  return existsSync(path) ? new Set(JSON.parse(readFileSync(path, "utf8")) as string[]) : null;
}

export function nextPass(points: readonly CurvePoint[]): number {
  return points.reduce((highest, point) => Math.max(highest, point.pass), 0) + 1;
}

export function passName(run: string, pass: number): string {
  return `${run}-p${String(pass).padStart(4, "0")}`;
}

const figure = (value: number | null): string => value === null ? "—" : value.toFixed(4);

// The curve as a table, gate by gate in pass order.
export function curveLines(points: readonly CurvePoint[]): string[] {
  const head = ["게이트", "회차", "행", "학습", "보정", "시험", "노드", "상태", "일치", "균형", "보정오차"];
  const body = [...points]
    .sort((left, right) => left.gate.localeCompare(right.gate) || left.pass - right.pass)
    .map((point) => [
      point.gate, String(point.pass), String(point.rows), String(point.train), String(point.calibration), String(point.test),
      point.node ?? "—", point.state === "done" ? "끝남" : point.state === "unreachable" ? "닿지 않음" : "실패",
      figure(point.agreement), figure(point.balanced), figure(point.ece),
    ]);
  const faults = points.filter((point) => point.fault !== null).map((point) => `${point.gate} ${point.pass}회차: ${point.fault}`);

  return [...laidOut(head, body), ...faults.length > 0 ? ["", ...faults] : []];
}
