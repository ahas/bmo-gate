# The layout

The repository holds one service, the gate stage of a turn, and the Laya decision filter that some gates ask
first. Laya's weights, the code that serves it and the code that trains it are kept apart, each in a folder of
its own, so a change to one never builds or tests the others.

## The top-level folders

| Folder | What it holds |
|---|---|
| `src/` | The root package: the version, the service binary, the Laya relay's binary and the unit command, built on the crates |
| `crates/` | The Rust crates the root package is built from: the store, the codes, the clients of the other units, the policy, the words, the markup, the gates and the reference selection, the service's routes and watches, the unit command's nouns, the Laya relay |
| `prompts/` | What each gate is told, a folder a gate, the questions Laya is asked, the evaluation set's members' briefs, the words the training tooling's judges are given, and the words the sanitiser's pre-filter matches in the rooms' own language: the one folder Korean stands in |
| `runtime/` | What serves Laya on its nodes: the decision server and the front around it, each a Python project of its own |
| `training/` | What makes Laya's checkpoints: the dataset and training tooling, a Bun project of its own, and the Python training scripts |
| `weights/` | The declarations of Laya's weights: each service's card declaration, in the card master's own format, and where the checkpoints are found, `checkpoints.toml`. The weights themselves are runtime data and never stand in the repository |
| `deploy/` | The service units and timers the testbed's deployment keeps |
| `client/` | The console plugin bundle: the gates' screen, a Nuxt layer on the base UI library |
| `docs/` | The documents, which come before the code |
| `tests/` | Every test of the repository, whatever its language |

A folder stands only once something is in it. The README's folder table names every top-level folder that
stands, and no other.

## The rules the layout keeps

- **One manifest at the root,** `Cargo.toml`. A Bun or Python project keeps its own manifest and lockfile in its
  own folder, one level down or more, and is a project of its own to the testbed.
- **No folder is named after its parent.** A folder's name says what it holds.
- **Tests live in `tests/`,** never beside the code they test. A Rust test is a Cargo test of the root package;
  a Bun project's tests stand under `tests/` in a folder named for the project; a Python suite stands under
  `tests/python/` and is run by a Cargo test of its own.
- **Korean stands only in `prompts/`.** A gate's instructions, Laya's questions, the evaluation set's briefs and
  the words the training tooling's judges are given, under `prompts/tooling/`, are worded as the models read them, and the sanitiser's trigger words as the rooms write them; every other file is English, and Korean a test feeds the code is written by its unicode escapes.
- **No weights, datasets or run output in git.** They are runtime data under the data root the settings name;
  the repository holds only the declarations that say where they are read from.

## The deployment

The testbed deploys the repository as `testbed.toml` declares it (the testbed's `docs/declaration.md` and
`docs/deploy.md`).

- **The deploy tree is the gate's own,** `~/.local/share/bmo-gate/deploy`, a release of the whole commit with the
  three binaries in its `bin/`: `gate-server`, `bmo-gate` and `laya-relay`. The runtime data root is the shared
  one, `~/.local/share/bmo/data`.
- **Two files each release links to the data root's `env/`:** its `settings.toml`, the service's settings
  (`docs/boundary-api.md`, 「Configuration」), to `env/gate.toml`, and the training tooling's
  `training/tooling/tooling.toml` (`docs/training.md`, 「The tooling and its settings」) to `env/gate-tooling.toml`.
  The tooling's packages are installed into the release before it is put live.
- **The units are `deploy/`'s,** each saying how the deployment keeps it:
  - `bmo-gate-server.service`, the service, is the one the deployment waits on, through `bmo-gate health`;
  - `bmo-laya-relay.service`, the relay, is restarted where its binary changed;
  - `bmo-gate-downgrade.timer` resumes the downgrade harvest every six hours, its service beside it;
  - `bmo-gate.service`, `bmo-gate-sanitizer.service`, `bmo-gate-judge.service` and `bmo-gate-train.service`, the
    writing runs, the judging run and a training pass, are linked and started by hand.
  Each tooling unit runs in the release's `training/tooling/`, under the data root `BMO_DATA_DIR` names.
- **The Python services stand on the nodes, not here.** The decision server, the front and the tunnel run on each
  node the Laya service's placement names, their units under `runtime/front/` put there by the installer from the
  release (`docs/llm-server.md`, 「Installing and updating」); the training scripts are put across by the training
  tooling (`docs/training.md`, 「The nodes」). The deployment installs none of them on the operations machine.

