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
| `crates/` | The Rust crates the root package is built from: the store |
| `docs/` | The documents, which come before the code: start with `docs/layout.md` |
| `src/` | The root package |
| `tests/` | Every test of the repository |

## Checking a change

- `cargo check --workspace --all-targets` — the static check.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` — the review.
- `cargo test` — every test, the repository checks among them.

## Version

The version stands in `VERSION` and in the workspace manifest, which hold the same number.
