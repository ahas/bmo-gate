# bmo-gate

Writes the distilled training data for the ten Laya split gates on the codex account.
`docs/gate-data.md` is the canonical account of the runner and comes before the code.

## What it is made of

- Bun and TypeScript, no runtime dependencies.
- `src/` holds the generator, the freezing and resume machinery, the audit and the codex road.
- `scripts/` holds the commands. Each takes `--help`.
- `bmo-gate.service` is the unit a full run is carried by, symlinked into the user's own unit
  directory. A full run is a day's work and belongs to no session.

## Checking a change

- `bunx tsc --noEmit` — the static check.
- `bun test` — the whole suite. `bun test <file>` for one.

## What this repository does not touch

- BMO's checkout is read for the specification and never written.
- Generated data never lands inside this checkout. It goes to the shared runtime data root, which
  is where BMO's training driver looks for it.
