# The layout

The repository holds one service, the gate stage of a turn, and the Laya decision filter that some gates ask
first. Laya's weights, the code that serves it and the code that trains it are kept apart, each in a folder of
its own, so a change to one never builds or tests the others.

## The top-level folders

| Folder | What it holds |
|---|---|
| `.graph/` | The code dependency graph: one node per feature, with the files it is made of and what it reads, written by the graph service and read by `bmo graph` |
| `src/` | The root package: the version, the service binary, the Laya relay's binary and the unit command, built on the crates |
| `crates/` | The Rust crates the root package is built from: the contract and its client, the store, the codes, the clients of the other units, the policy, the words, the markup, the gates and the reference selection, the service's routes and watches, the unit command's nouns, the Laya relay |
| `prompts/` | What each gate is told, a folder a gate, the questions Laya is asked, the evaluation set's members' briefs, the words the training tooling hands its writers and judges and the stand-ins its rows carry, and the words the sanitiser's pre-filter matches in the rooms' own language: the one folder Korean stands in |
| `runtime/` | What serves Laya on its nodes: the decision server and the front around it, each a Python project of its own; and the GGUF engine's unit templates and node setup (`docs/gguf-llm.md`) |
| `training/` | What makes Laya's checkpoints: the dataset and training tooling, a Bun project of its own, and the Python training scripts |
| `weights/` | The declarations of Laya's weights: each service's card declaration, in the card master's own format, and where the checkpoints are found, `checkpoints.toml`. The weights themselves are runtime data and never stand in the repository |
| `deploy/` | The service units the testbed's deployment keeps |
| `package/` | The TypeScript client generated from `docs/openapi.json`, which the console bundle and any other TypeScript caller use |
| `client/` | The console plugin bundle: the gates' screens, the ES module the gate serves and a Nuxt layer on the base UI library |
| `docs/` | The documents, which come before the code |
| `tools/` | The tools a tool host places: the translator's tool, a folder with its manifest, its schemas, its manual and its executable's crate (`docs/api.md`, 「The tool a tool host places」) |
| `tests/` | Every test of the repository, whatever its language |

A folder stands only once something is in it. The README's folder table names every top-level folder that
stands, and no other.

## The rules the layout keeps

- **One manifest at the root,** `Cargo.toml`. A Bun or Python project keeps its own manifest and lockfile in its
  own folder, one level down or more, and is a project of its own to the testbed.
- **No folder is named after its parent.** A folder's name says what it holds.
- **Tests live in `tests/`,** never beside the code they test. A Rust test is a Cargo test of the root package;
  a Bun project's tests stand under `tests/` in a folder named for the project; the Laya suites stand under
  `tests/laya/` and are run by a Cargo test of their own.
- **Korean stands only in `prompts/`.** A gate's instructions, Laya's questions, the evaluation set's briefs and
  the words the training tooling hands its writers and judges and the stand-ins and placeholders its rows carry, under `prompts/tooling/`, are worded as the models read them, and the sanitiser's trigger words as the rooms write them; every other file is English, and the Korean a test feeds the code, a pattern reads, a bench sends as a sample state or the console bundle's Korean words (`client/i18n/ko.json`, the piece of a console's language pack the bundle carries) hold is written by its unicode escapes and recorded in `korean-ledger.json`, which the testbed's language check reads.
- **No weights, datasets or run output in git.** They are runtime data under the data root the settings name;
  the repository holds only the declarations that say where they are read from.

## The console plugin bundle

`client/` is the gates' screens as a console takes them under bmo-ui's console plugin contract (bmo-ui's
`docs/console-bundles.md`): a Bun project of its own, its manifest, its lockfile and its configurations one level
below the root, and its tests under `tests/client/`.

- **One set of pages, two forms.** The pages under `app/pages/` are built into the ES module the gate serves, and
  are as well a Nuxt layer on bmo-ui that `bun pm pack` packs for a host that extends it. `bun run bundle` builds
  the module from `console/`'s entry and configuration, once the install has prepared the layer's `.nuxt/` whose
  theme the stylesheet is built against, into `dist/`: `bundle.js`, `bundle.css` and `words.json`,
  the folder the settings' `[console]` names (`docs/boundary-api.md`, 「Configuration」), which the gate answers
  as its manifest, its module, its stylesheet and its words (`docs/api.md`, 「Console」).
- **The module** default-exports `{ routes }`, the routes of the two pages under the screen path `/gates`. It
  leaves every import of `vue`, `vue-router`, `vue-i18n`, `nuxt/app`, `@nuxt/ui` and `bmo-ui` unbundled, written as
  the package's own path, and carries the rest itself. Its stylesheet is the utility classes the pages use, on the
  layer's tokens, which the console's copy defines.
- **Every import is written out.** A page imports what it uses by the package's path: Vue's and the router's
  functions, the i18n's `useI18n`, `@nuxt/ui`'s components and bmo-ui's components and domain modules; it leans on
  no auto-import and on no component of a host's, so one file reads alike in the module and in the layer. The
  bundle's own files are reached by relative path.
- **The pages.** `/gates` is the gate order, each gate in its part and step, with its Laya mode and how often
  Laya agrees with it where Laya is asked on it, each leading to the gate's own page. `/gates/<gate>` puts a
  prompt to one gate as a turn would and lists the gate's trials, oldest first, each with who asked where the
  trial names it, the answer as the gate wrote it and how long it took; beside the gate's name stand its Laya
  mode and agreement. Another gate's page reads that gate afresh.
- **No page focuses an input on arrival.** The prompt on a gate's page waits to be touched, so opening the page
  on a phone raises no keyboard.
- **The calls** go to the gate's screen routes under `/console` at the address bmo-ui's `relay` module answers
  for the service `gate`, through the app's fetcher. A refusal is shown as the words' `gates.error.<code>`, the
  code's hyphens as underscores, where they hold it, and the page's own fallback otherwise.
- **The words** are `i18n/<locale>.json`, each a tree under `gates`, beside the layer's own `common.*` keys. A
  gate's name is the key `gates.label.<gate>` with its hyphens as underscores, and the gate's own name where the
  words hold no such key; a Laya mode is `gates.laya_mode.<mode>`, the mode's own word where they hold none.
- **bmo-ui** is a peer at the one version the bundle is built against; for the bundle's own install a packed copy
  under `client/vendor/` is a development dependency, and bmo-ui's patch stands under `client/patches/`.
- **What a host owes** is what the contract asks of a console: its copies of the shared libraries, the relay of
  the service `gate` for the API prefix, the module and the stylesheet, the reader's role on every relayed call,
  and the bundle's words merged into its pack. A host extending the layer brings its i18n module with those words.

## The deployment

The testbed deploys the repository as `testbed.toml` declares it (the testbed's `docs/declaration.md` and
`docs/deploy.md`).

- **The deploy tree is the gate's own,** `~/.local/share/bmo-gate/deploy`, a release of the whole commit with the
  three binaries in its `bin/`: `gate-server`, `bmo-gate` and `laya-relay`. The runtime data root is the shared
  one, `~/.local/share/bmo/data`.
- **Two files each release links to the data root's `env/`:** its `settings.toml`, the service's settings
  (`docs/boundary-api.md`, 「Configuration」), to `env/gate.toml`, and the training tooling's
  `training/tooling/tooling.toml` (`docs/training.md`, 「The tooling and its settings」) to `env/gate-tooling.toml`.
  The tooling's packages are installed into the release before it is put live, and the console bundle is built
  into the release's `client/dist/`, the folder the deployed settings' `[console]` names.
- **The units are `deploy/`'s,** each saying how the deployment keeps it:
  - `bmo-gate-server.service`, the service, is the one the deployment waits on, through `bmo-gate health`;
  - `bmo-laya-relay.service`, the relay, is restarted where its binary changed;
  - `bmo-gate.service`, `bmo-gate-judge.service` and `bmo-gate-train.service`, the writing run, the judging run
    and a training pass, are linked and started by hand. No unit builds the sanitiser gate's rows or runs the
    downgrade harvest: their code is not carried (`docs/gate-data.md`, 「Not carried」).
  Each tooling unit runs in the release's `training/tooling/`, under the data root `BMO_DATA_DIR` names.
- **The translator's tool is placed with the tool host** before the release is put live: its executable,
  `gate-translate-tool`, a fourth binary of the release's `bin/`, is copied beside its manifest, schemas and manual,
  and the folder is put with `bmo pocket put` as the gate's own, allowing the capability its entry asks for
  (`docs/api.md`, 「The tool a tool host places」).
- **The Python services stand on the nodes, not here.** The decision server, the front and the tunnel run on each
  node the Laya service's placement names, their units under `runtime/front/` put there by the installer from the
  release (`docs/llm-server.md`, 「Installing and updating」); the training scripts are put across by the training
  tooling (`docs/training.md`, 「The nodes」); a GGUF model's engine and tunnel are put on their node by the GGUF
  engine's installer, their units filled from `runtime/gguf-llm/`'s templates (`docs/gguf-llm.md`). The deployment
  installs none of them on the operations machine.

