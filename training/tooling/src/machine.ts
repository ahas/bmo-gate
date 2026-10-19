import type { NodeCalls } from "./node-calls";

// What a node's machine is, read from the machine itself at install (the arbiter's docs/node-arbiter.md,
// 「What the install reads and writes」): whether it is a WSL machine, which is a person's Windows desktop whose card and memory come
// first, and its card's name and size. Nothing of it is written into this project; an install asks it
// afresh every time.

export interface Machine {
  /** A WSL machine: a Windows desktop, its card the desktop's first. */
  wsl: boolean;
  /** The first card, or null where the driver answers for none. */
  card: { name: string; totalMiB: number } | null;
}

/** One line a value, each asked of the driver alone so no answer has to be split. WSL keeps the
 * driver's tools in a folder of its own. */
export function probeCommand(): string {
  const smi = "nvidia-smi -i 0 --format=csv,noheader";
  return "export PATH=$PATH:/usr/lib/wsl/lib; "
    + "if grep -qi microsoft /proc/version; then echo MACHINE_WSL=1; else echo MACHINE_WSL=0; fi; "
    + `echo "MACHINE_CARD_MIB=$(${smi},nounits --query-gpu=memory.total 2>/dev/null | head -n 1)"; `
    + `echo "MACHINE_CARD_NAME=$(${smi} --query-gpu=name 2>/dev/null | head -n 1)"`;
}

function said(text: string, name: string): string | null {
  const line = text.split("\n").map((one) => one.trim()).find((one) => one.startsWith(`${name}=`));

  return line === undefined ? null : line.slice(name.length + 1).trim();
}

/** The machine out of the probe's answer, or null where the answer is not the probe's. */
export function parseMachine(text: string): Machine | null {
  const wsl = said(text, "MACHINE_WSL");
  if (wsl !== "0" && wsl !== "1") {
    return null;
  }
  const mib = Number(said(text, "MACHINE_CARD_MIB") ?? "");
  const name = said(text, "MACHINE_CARD_NAME") ?? "";

  return { wsl: wsl === "1", card: Number.isInteger(mib) && mib > 0 && name !== "" ? { name, totalMiB: mib } : null };
}

/** The node's machine, or why it could not be read. */
export async function probeMachine(exec: NodeCalls["exec"]): Promise<Machine | string> {
  const asked = await exec(probeCommand());
  const machine = asked.code === 0 ? parseMachine(asked.stdout) : null;

  return machine ?? `the machine could not be read — ${(asked.stderr.trim() || asked.stdout.trim()).slice(-300) || `exit code ${asked.code}`}`;
}
