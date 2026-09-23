# bmo-gate

Two things BMO's gates ask stand here whole, and nothing here is a part of BMO:

- **Laya,** the decision filter BMO places in front of some of its gates: the server that answers,
  the distilled training data the ten split gates are trained on, and the training run that makes
  the checkpoints.
- **The house LLM service on n6,** the small served model BMO's gates can be routed to: the MCP and
  OpenAI-compatible front, its units, the node setup and the installer that puts it there.

BMO holds only the clients that ask these two and the configuration of which gate asks which.

Most gates' rows ride the codex account; the sanitiser gate, whose attack rows codex refuses at the
account level, rides the J3090 road instead.

## The documents, which come before the code

- `docs/gate-data.md` — the rows: where they come from, what leaves the rooms with them, how they are
  judged, the roads, a run and its folders, the bars a gate must clear, and the commands.
- `docs/laya-gates.md` — the specification the rows answer to: what each of the ten gates receives,
  asks, and may answer, and the language mix and answer balance its data is drawn to.
- `docs/laya-train-run.md` — the run across the four training nodes: the rehearsal, the checkpoints
  and their collection, the resume contract, the ledger, the two tables a gate is judged on, and the
  passes that train the gates while their judging runs and keep the score curve.
- `docs/laya-server.md` — the server on home-pc, what it was measured at, the training loop and its
  fixed settings, the calibration, and what the savings cost.
- `docs/llm-server.md` — the house LLM service on n6: the model and how the card is divided, the
  engine, the front and its one tool, the units, the tunnel that is its door, the key, the install
  and the checks.

## What it is made of

- Bun and TypeScript, no runtime dependencies.
- `src/` holds the generator, the freezing and resume machinery, the audit, the two roads (codex and
  J3090), the rehearsal, the training driver, the checkpoint collection, the verification tables, the
  jake console plumbing both halves drive the nodes with, and the LLM service's install steps and
  the tunnel's door on main-host.
- `scripts/` holds the commands. Each takes `--help`.
- `laya-server/` holds the Python server, the training and calibration scripts it is installed
  beside, and the unit file. It is a virtual environment of its own on the machine it runs on and
  shares nothing with the Bun side.
- `llm-server/` holds the house LLM service's front, the tunnel's dial client, its node setup, its
  three user units and the nginx config of the tunnel's proxy host. It stands in a virtual
  environment of its own on n6, the same way.
- `scripts/llm-install.ts` puts that service on n6 through the jake console and is the one way it is
  installed or updated.
- `bmo-gate.service` is the unit a full run is carried by, symlinked into the user's own unit
  directory. A full run is a day's work and belongs to no session.
- `bmo-llm-bridge.service` runs `scripts/llm-bridge.ts`, the LLM service's tunnel door on
  main-host, symlinked the same way by the install.
- `bmo-gate-curve.service` and its `.timer` run a training pass every thirty minutes while the
  judging goes on, symlinked the same way.

## Checking a change

- `bunx tsc --noEmit` — the static check.
- `bun test` — the whole suite. `bun test <file>` for one.
- The LLM service's Python side, which `bun test` does not reach:
  `uv run --no-project --with mcp --with httpx --with starlette --with uvicorn --with websockets python3 -m unittest llm-server/test_front.py llm-server/test_ws_dial.py`.

## What this repository does not touch

- BMO's archive is opened read-only for the real rows and is never written.
- A gate's mode and τ are BMO's configuration and 하스's decision; nothing here writes either.
- Generated data never lands inside this checkout. It goes to the shared runtime data root, which is
  where the training driver here looks for it.
