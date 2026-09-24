# bmo-gate

Laya, the decision filter BMO places in front of some of its gates, stands here whole, and nothing
here is a part of BMO:

- **The service on n6 that answers,** one checkpoint per gate: the server, the MCP and
  OpenAI-compatible front around it, their units, the tunnel that brings it to main-host, the node
  setup, the installer and the command that puts a checkpoint in service.
- **The distilled training data** the ten split gates are trained on.
- **The training run** that makes the checkpoints.

BMO holds only the client that asks the service and the configuration of which gate asks.

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
- `docs/laya-server.md` — the server, which checkpoint answers which gate, how the card is shared,
  what it was measured at on n6, the training loop and its fixed settings, the calibration, and what
  the savings cost.
- `docs/reference-use.md` — whether BMO's answers used what the four reference gates attached: the
  judgement, its words, the figures read off it, its training shape, and what it measured.
- `docs/llm-server.md` — the Laya service on n6: the machine, the engine, the front with its MCP
  tools and OpenAI-compatible call, the units, the tunnel that is its door, the key, the install,
  putting a checkpoint in service, and the checks.

## What it is made of

- Bun and TypeScript, no runtime dependencies.
- `src/` holds the generator, the freezing and resume machinery, the audit, the two roads (codex and
  J3090), the rehearsal, the training driver, the checkpoint collection, the verification tables, the
  jake console plumbing that drives the nodes, the service's install steps, carrying a checkpoint
  into service, and the tunnel's door on main-host.
- `scripts/` holds the commands. Each takes `--help`.
- `laya-server/` holds the Python server and the training and calibration scripts. It is a virtual
  environment of its own on the machine it runs on and shares nothing with the Bun side.
- `llm-server/` holds the service's front, the tunnel's dial client, its node setup, its three user
  units and the nginx config of the tunnel's proxy host. It stands in a virtual environment of its
  own on n6, the same way.
- `scripts/llm-install.ts` puts the service on n6 through the jake console and is the one way it is
  installed or updated; `scripts/laya-serve.ts` carries a collected checkpoint there and names it
  for a gate.
- `bmo-gate.service` is the unit a full run is carried by, symlinked into the user's own unit
  directory. A full run is a day's work and belongs to no session.
- `bmo-llm-bridge.service` runs `scripts/llm-bridge.ts`, the service's tunnel door on
  main-host, symlinked the same way by the install.
- `bmo-gate-curve.service` and its `.timer` run a training pass every thirty minutes while the
  judging goes on, symlinked the same way.
- `bmo-gate-reference-use.service` and its `.timer` judge the reference gates' new turns by what
  BMO's answer used and run a training pass over them every hour, symlinked the same way.

## Checking a change

- `bunx tsc --noEmit` — the static check.
- `bun test` — the whole suite. `bun test <file>` for one.
- The Laya server's Python side, which `bun test` does not reach either, on the system Python:
  `python3 -m unittest laya-server/test_server.py laya-server/test_resume.py laya-server/test_metrics.py`.
- The service front's Python side, which `bun test` does not reach:
  `uv run --no-project --with mcp --with httpx --with starlette --with uvicorn --with websockets python3 -m unittest llm-server/test_front.py llm-server/test_ws_dial.py`.

## What this repository does not touch

- BMO's archive is opened read-only for the real rows and is never written.
- A gate's mode and τ are BMO's configuration and 하스's decision; nothing here writes either.
- Generated data never lands inside this checkout. It goes to the shared runtime data root, which is
  where the training driver here looks for it.
