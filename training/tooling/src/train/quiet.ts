import { freemem } from "node:os";

// Whether the operations machine is quiet enough for a reference round to go on (docs/reference-data.md
// 「A round on request」). The round's pass of the data, its judge's calls and the training's driver run
// here beside the jobs and share this machine's memory, so the round waits while a job or another
// training runs or while memory is short.

// What the round gives way to, read off the user units running: a job is a transient unit of that
// prefix, and the judging run's training is this project's own unit.
const jobPrefix = "bmo-task-";
const trainings: readonly { prefix: string; what: string }[] = [
  { prefix: "bmo-gate-train.service", what: "the judging run's training" },
];

// The memory left for the jobs beside a training's driver, unless the caller needs more.
export const quietMemoryBytes = 6 * 1024 ** 3;

export interface QuietReading {
  // The user units active or starting — a oneshot unit at work reads as starting.
  units: readonly string[];
  availableBytes: number;
}

/** What keeps the machine from being quiet, one line each; none is quiet. */
export function busyWith(reading: QuietReading, spare: readonly string[], memoryBytes: number = quietMemoryBytes): string[] {
  const busy: string[] = [];
  const spared = new Set(spare.map((unit) => (unit.endsWith(".service") ? unit : `${unit}.service`)));
  const units = reading.units.filter((unit) => !spared.has(unit));
  const jobs = units.filter((unit) => unit.startsWith(jobPrefix));

  if (jobs.length > 0) {
    busy.push(`${jobs.length} job${jobs.length === 1 ? " runs" : "s run"} (${jobs.join(", ")})`);
  }

  for (const training of trainings) {
    const running = units.filter((unit) => unit.startsWith(training.prefix));

    if (running.length > 0) {
      busy.push(`${training.what} runs (${running.join(", ")})`);
    }
  }

  if (reading.availableBytes < memoryBytes) {
    busy.push(`${gib(reading.availableBytes)}GiB of memory is left, below ${gib(memoryBytes)}GiB`);
  }

  return busy;
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** This machine as it stands: its user units at work and the memory still available. */
export function readQuiet(): QuietReading {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
  const listed = Bun.spawnSync(
    ["systemctl", "--user", "list-units", "--type=service", "--state=active,activating", "--output=json", "--no-pager"],
    { stdin: "ignore", env: { ...process.env, XDG_RUNTIME_DIR: runtime } },
  );

  if (listed.exitCode !== 0) {
    throw new Error(`systemctl --user list-units failed — ${listed.stderr.toString().trim()}`);
  }

  const units = (JSON.parse(listed.stdout.toString()) as { unit: string }[]).map((one) => one.unit);

  return { units, availableBytes: freemem() };
}

export interface QuietWait {
  spare: readonly string[];
  read: () => QuietReading;
  wait: (ms: number) => Promise<void>;
  say: (line: string) => void;
  // The memory that must stand available, the driver's floor where not given.
  memoryBytes?: number;
  everyMs?: number;
  // How many readings pass between two lines saying what the wait is for.
  sayEvery?: number;
}

/** Waits, without bound, until nothing keeps the machine busy, and answers how long it waited. */
export async function waitQuiet(hands: QuietWait): Promise<number> {
  const everyMs = hands.everyMs ?? 60_000;
  const sayEvery = hands.sayEvery ?? 10;
  let waited = 0;

  for (let reading = 0; ; reading += 1) {
    const busy = busyWith(hands.read(), hands.spare, hands.memoryBytes);

    if (busy.length === 0) {
      if (waited > 0) {
        hands.say(`${stamp()} quiet now, going on — waited ${Math.round(waited / 60_000)} minutes`);
      }

      return waited;
    }

    if (reading % sayEvery === 0) {
      hands.say(`${stamp()} waiting for other work to end — ${busy.join("; ")}`);
    }

    await hands.wait(everyMs);
    waited += everyMs;
  }
}

function stamp(): string {
  // The machine's own time of day, so a line reads against its other logs.
  return new Date().toLocaleTimeString("sv-SE");
}
