import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// One living writer to a gate (docs/gate-data.md 「Resuming, and not writing over」). A run folder
// can be driven by two runs at once — one gate on its own road beside the rest on another — and
// nothing in the resume settles which of two drivers writing the same gate wins. Both read the
// same last frozen batch, both buy the next one from the model, and the answer that lands second
// is written over rows that were already good.
//
// A claim carries its writer's process id in its own name, so no two writers ever touch the same
// file and a claim can be told from its owner still being there. Whoever claimed first holds the
// gate: a writer lays its own claim down, then reads every claim standing in the folder, and a
// writer whose claim is not the eldest gives it up and leaves the gate alone.
//
// That order is what makes the answer the same however the two arrived. A writer always reads
// after it has written, so of any two, at least one sees both claims: where both do they read the
// same folder and agree, and where only one does, it is the later of the two and it is the one
// that stands down. A claim is never handed to two writers, and the worst a dead heat costs is
// that both stand down and the next start settles it.

const claimPrefix = ".writer.";

export interface GateClaim {
  pid: number;
  // When the claim was laid down. The eldest living claim is the one that holds the gate.
  since: number;
  name: string;
}

function claimName(since: number, pid: number): string {
  return `${claimPrefix}${since}.${pid}`;
}

function readClaimName(name: string): GateClaim | null {
  if (!name.startsWith(claimPrefix)) {
    return null;
  }

  const [since, pid] = name.slice(claimPrefix.length).split(".");
  const when = Number(since);
  const who = Number(pid);

  if (!Number.isInteger(when) || !Number.isInteger(who) || who <= 0) {
    return null;
  }

  return { pid: who, since: when, name };
}

export function claimsIn(folder: string): GateClaim[] {
  try {
    return readdirSync(folder).map(readClaimName).filter((one): one is GateClaim => one !== null);
  } catch {
    return [];
  }
}

// Whether a claim's writer is still there. A process nobody here may signal is somebody else's and
// is alive; only the one that is gone outright frees its claim.
export function writerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (trouble) {
    return (trouble as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ClaimHands {
  pid: number;
  now: number;
  alive: (pid: number) => boolean;
}

const ownHands: ClaimHands = { pid: process.pid, now: 0, alive: writerAlive };

// Null where the gate is this writer's to write, and the refusal to print where it is not.
export function claimGate(folder: string, hands: Partial<ClaimHands> = {}): string | null {
  const { pid, alive } = { ...ownHands, ...hands };
  const since = hands.now ?? Date.now();
  const mine = claimName(since, pid);

  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, mine), "");

  // A claim whose writer is gone is no claim. Only its own writer ever writes that name, and that
  // writer is gone, so nothing is taken from anybody by clearing it away.
  for (const one of claimsIn(folder)) {
    if (one.pid !== pid && !alive(one.pid)) {
      rmSync(join(folder, one.name), { force: true });
    }
  }

  const elder = claimsIn(folder).find((one) =>
    one.name !== mine && alive(one.pid) && (one.since < since || (one.since === since && one.pid !== pid)));

  if (elder === undefined) {
    return null;
  }

  rmSync(join(folder, mine), { force: true });

  return [
    `${folder} 는 다른 실행(pid ${elder.pid})이 쓰고 있습니다.`,
    "한 게이트는 한 번에 한 실행만 씁니다. 그 실행이 끝나거나 죽은 뒤에 이어 가세요.",
  ].join("\n");
}

// Given up when the gate finishes or falls over, so the next run takes it up without waiting for
// anything to go stale.
export function releaseGate(folder: string, hands: Partial<ClaimHands> = {}): void {
  const { pid } = { ...ownHands, ...hands };

  for (const one of claimsIn(folder)) {
    if (one.pid === pid) {
      rmSync(join(folder, one.name), { force: true });
    }
  }
}
