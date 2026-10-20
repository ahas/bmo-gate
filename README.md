# bmo-gate

The gate stage of a turn, as one service of its own. Between the moment a chat receiver has built a turn's
envelope and the moment an agent's answer goes back into the room, the gate:

- **sanitises** the words on their way into a model's context;
- **picks the reference** a turn is handed: memory rows, room rules, situation rules, documents and the person
  book, out of the material the brain service serves;
- **checks the answer** on its way out, the output gate;
- **translates** what a worker or a document needs in another language, and keeps the translations;
- **records** every judgement it makes, and the road each run walked;
- asks **Laya** first where a gate is set to: a small decision model, one checkpoint per gate, served on the
  nodes its placement names.

Laya's weights, the code that serves it and the code that trains it are kept apart (`docs/layout.md`). The large
text model a gate may ride is not here: it stands as an OpenAI-compatible endpoint of its own, which the gate
reaches only as a registration.

Every other unit is reached through standard APIs alone, and of other repositories only the base libraries
`bmo-chat`, `bmo-chat-client` and `bmo-ui` may be depended on.

## Folders

| Folder | What it holds |
|---|---|
| `client/` | The console plugin bundle: the gates' trial page and its server routes, a Nuxt layer on bmo-ui and a Bun project of its own |
| `crates/` | The Rust crates the root package is built from: the contract and its client, the store, the codes, the ports to the other units, the policy, the words, the markup, the gate runs, the gates, the reference road, the service's routes, the unit command's nouns and the Laya relay |
| `deploy/` | The service units the testbed's deployment keeps on the operations machine |
| `docs/` | The documents, which come before the code: start with `docs/layout.md`, and read `docs/api.md` for the public API and `docs/openapi.json` for its machine form |
| `package/` | The TypeScript client generated from `docs/openapi.json` |
| `prompts/` | What each gate is told, the questions Laya is asked, the evaluation set's briefs, the training tooling's prompts, judge words and the data its rows carry, and the sanitiser's trigger words, the one folder Korean stands in |
| `runtime/` | What serves Laya on its nodes: the decision server, its card turn client and the front, each a Python project of its own |
| `src/` | The root package: the version, the `gate-server` and `laya-relay` binaries and the `bmo-gate` unit command |
| `tests/` | Every test of the repository |
| `training/` | What makes Laya's checkpoints: the dataset and training tooling, a Bun project of its own, and the training scripts and node scripts the training runs |
| `weights/` | The declarations of Laya's weights: the card declarations of the service and its training, and where the checkpoints stand; never the weights themselves |

`PERSONAL-DATA.md` states the personal data no file may hold: whose it is, what counts, where a value belongs
instead, and the check that holds it.

## Checking a change

- `cargo check --workspace --all-targets` — the static check.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` — the review.
- `cargo test` — every test, the repository checks among them, the personal-data check included.

## Version

The version stands in `VERSION` and in the workspace manifest, which hold the same number.

## License

MIT. The licence text stands in `LICENSE`, and every manifest declares the same licence.
