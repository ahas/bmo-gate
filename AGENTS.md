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
account level, rides the J3090 road instead. While the codex account is shut, a judging pass or a
top-up run can ride the claude road, pinned to one Claude login.

## The documents, which come before the code

- `docs/gate-data.md` — the rows of every gate but the four reference gates: where they come from,
  what leaves the rooms with them, how they are judged, the roads, a run and its folders, the bars a
  gate must clear, and the commands.
- `docs/reference-data.md` — the four reference gates' data: the turns, the input BMO's own code
  builds for them, whether the answer used or needed each piece, the labels that are all it keeps,
  the rows made afresh every pass, the figures, and the hourly pass.
- `docs/laya-gates.md` — the specification the rows answer to: what each of the ten gates receives,
  asks, and may answer, and the language mix and answer balance its data is drawn to.
- `docs/training.md` — how a gate's data becomes a calibrated checkpoint and a table: the sources, when
  a gate is trained, a pass over the four training nodes, one gate's run on a node, the settings, the
  resume contract, the collection, the ledger and the curve, the tables, and the rehearsal.
- `docs/laya-server.md` — the server, which checkpoint answers which gate, how the card is shared,
  what it was measured at on n6, the training loop and its fixed settings, the calibration, and what
  the savings cost.
- `docs/llm-server.md` — the Laya service on n6: the machine, the engine, the front with its MCP
  tools and OpenAI-compatible call, the units, the tunnel that is its door, the key, the install,
  putting a checkpoint in service, and the checks.

## What it is made of

- Bun and TypeScript, no runtime dependencies.
- `src/` holds the generator, the freezing and resume machinery, the audit, the three roads (codex,
  J3090 and the claude road), the rehearsal, the checkpoint collection, the jake console plumbing that drives the nodes,
  the service's install steps, carrying a checkpoint into service, and the tunnel's door on
  main-host. `src/reference/` is the reference gates' data and `src/train/` the training driver.
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
- `bmo-gate-train.service` and its `.timer` run a training pass over the judging run every thirty
  minutes, symlinked the same way.
- `bmo-gate-reference-data.service` and its `.timer` make a pass of the reference gates' data and
  then a training pass over it every hour, symlinked the same way. The data pass reads BMO's
  `scripts/reference-inputs.ts` in BMO's live checkout, pointed at the pass's archive copy.

## Checking a change

- `bunx tsc --noEmit` — the static check.
- `bun test` — the whole suite. `bun test <file>` for one.
- The Laya server's Python side, which `bun test` does not reach either, on the system Python:
  `python3 -m unittest laya-server/test_server.py laya-server/test_resume.py laya-server/test_metrics.py`.
- The service front's Python side, which `bun test` does not reach:
  `uv run --no-project --with mcp --with httpx --with starlette --with uvicorn --with websockets python3 -m unittest llm-server/test_front.py llm-server/test_ws_dial.py`.

## What this repository does not touch

- BMO's live archive is never opened. Each run reads a copy of it taken for itself, read-only
  (`docs/gate-data.md`, 「The archive copy」).
- A gate's mode and τ are BMO's configuration and 하스's decision; nothing here writes either.
- Generated data never lands inside this checkout. It goes to the shared runtime data root, which is
  where the training driver here looks for it.
