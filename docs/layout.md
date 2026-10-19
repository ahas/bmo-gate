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
