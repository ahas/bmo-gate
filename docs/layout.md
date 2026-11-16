# The layout

The repository holds one service, the gate stage of a turn: the reference a turn is handed, the translator, and
the judgements and road records the gate keeps.

## The top-level folders

| Folder | What it holds |
|---|---|
| `.graph/` | The code dependency graph: one node per feature, with the files it is made of and what it reads, written by the graph service and read by `bmo graph` |
| `src/` | The root package: the version, the service binary and the unit command, built on the crates |
| `crates/` | The Rust crates the root package is built from: the contract and its client, the store, the codes, the clients of the other units, the policy, the words, the markup, the runs, the reference road, the service's routes and watches, and the unit command |
| `runtime/` | The GGUF engine's unit templates and node setup (`docs/gguf-llm.md`) |
| `training/` | The tooling the deployment runs on the operations machine: a Bun project of its own, which places a GGUF model on a node (`docs/gguf-llm.md`) |
| `deploy/` | The service unit the testbed's deployment keeps |
| `package/` | The TypeScript client generated from `docs/openapi.json`, which any TypeScript caller uses |
| `docs/` | The documents, which come before the code |
| `tools/` | The tools a tool host places: the translator's tool and the brain's index tool, each a folder with its manifest, its schemas, its manual and its executable's crate (`docs/api.md`, 「The tools a tool host places」) |
| `tests/` | Every test of the repository, whatever its language |

A folder stands only once something is in it. The README's folder table names every top-level folder that
stands, and no other.

## The rules the layout keeps

- **One manifest at the root,** `Cargo.toml`. A Bun or Python project keeps its own manifest and lockfile in its
  own folder, one level down or more, and is a project of its own to the testbed.
- **No folder is named after its parent.** A folder's name says what it holds.
- **Tests live in `tests/`,** never beside the code they test. The Rust tests are the root package's one test
  target, the harness `tests/main.rs` named `main` (bmo-chat's `docs/conventions.md`, 「Rust builds」): each
  check that spans the repository a module of a file at the top of `tests/`, each crate's tests a module of a
  folder named after it, and what they share the `support` module. One module's tests run as
  `bmo-testbed cargo test --test main <module>::`. A Bun project's tests stand under `tests/` in a folder named
  for the project.
- **A test that needs a store makes a database of its own** on the server `BMO_TEST_POSTGRES` names, else the
  local socket's `bmo_test`. The first such test of a harness process migrates a template with the store's
  migrator, named `bmo_gate_test_tmpl_` followed by the process id, and each test gets a copy of it, or a blank
  database, named `bmo_gate_test_copy_` followed by the process id and a count.
  - A copy is dropped when its test ends, and the test fails if the drop does: the drop first ends the suite
    role's own sessions on the database and then drops it without forcing, since forcing needs the right to end
    other roles' processes, an autovacuum worker's among them, which the suite's role need not hold, while the
    plain drop stops an autovacuum worker itself.
  - Before a harness process makes its first database it drops every template and copy whose process no longer
    runs on this machine and that no session is on, so a process that ended or was killed, and the template it
    kept to its end, leave nothing behind past the next run. A database the sweep cannot drop is named on the
    error stream. The sweep reads these two names and the two a checkout behind this rule still makes them
    under, `gate_rs_tmpl_` and `gate_rs_copy_`, and no other.
- **No weights, datasets or run output in git.** They are runtime data under the data root the settings name;
  the repository holds only the declarations that say where they are read from.

## The deployment

The testbed deploys the repository as `testbed.toml` declares it (the testbed's `docs/declaration.md` and
`docs/deploy.md`).

- **The deploy tree is the gate's own,** `~/.local/share/bmo-gate/deploy`, a release of the whole commit with the
  two binaries in its `bin/`: `gate-server` and `bmo-gate`. The runtime data root is the shared one,
  `~/.local/share/bmo/data`.
- **Two files each release links to the data root's `env/`:** its `settings.toml`, the service's settings
  (`docs/boundary-api.md`, 「Configuration」), to `env/gate.toml`, and the tooling's
  `training/tooling/tooling.toml` (`docs/training.md`, 「The tooling and its settings」) to `env/gate-tooling.toml`.
  The tooling's packages are installed into the release before it is put live.
- **The unit is `deploy/`'s:** `bmo-gate-server.service`, the service, is the one the deployment waits on,
  through `bmo-gate health`. Four units stand marked `retire` — `bmo-laya-relay.service`, `bmo-gate.service`,
  `bmo-gate-judge.service` and `bmo-gate-train.service` — which the deployment stops, disables and unlinks once
  the service is up; a later commit removes their files.
- **The unit command stands beside `bmo`:** before the release is put live, `bmo-gate` is stood in the folder
  holding `bmo`, the first folder `bmo` looks for unit commands in (`docs/boundary-api.md`, 「The unit command」). It
  is a script that runs the deploy tree's own link, which stands across releases, and names the settings that tree
  carries, so a command run from any folder reads them.
- **The two tools are placed with the tool host** before the release is put live: each executable,
  `gate-translate-tool` and `gate-reference-tool`, binaries of the release's `bin/`, is copied beside its manifest,
  schemas and manual, and each folder is put with `bmo pocket put` as the gate's own, allowing the capability its
  entries ask for, `gate.translate` and `gate.reference` (`docs/api.md`, 「The tools a tool host places」).
- **The GGUF engine stands on a node, not here.** Its installer puts its engine and tunnel units there from the
  release's `runtime/gguf-llm/` templates (`docs/gguf-llm.md`). The deployment installs none of it on the
  operations machine.
