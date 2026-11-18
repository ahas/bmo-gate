# bmo-gate

The gate stage of a turn, as one service of its own. Between the moment a chat receiver has built a turn's
envelope and the moment an agent's answer goes back into the room, the gate:

- **hands a turn its reference** with no pick — each speaker's sheet head, the room's due memories and the rows
  the turn's events wake — and serves the brain's index, its pieces and a search of it, which the agent reads the
  rest of its brain through;
- **translates** what a worker or a document needs in another language, and keeps the translations;
- **records** every judgement it is told, and the road each run walked.

The gate order holds no gate: the agent formats its own reply and keeps its own session (`docs/gates.md`). The
large text model a turn may ride is not here: it stands as an OpenAI-compatible endpoint of its own, which the
gate reaches only as a registration.

Every other unit is reached through standard APIs alone, and of other repositories only the base libraries
`bmo-chat`, `bmo-chat-client` and `bmo-ui` may be depended on.

## Folders

| Folder | What it holds |
|---|---|
| `crates/` | The Rust crates the root package is built from: the contract and its client, the store, the codes, the ports to the other units, the policy, the words, the markup, the runs, the reference road, the service's routes and the unit command |
| `deploy/` | The service unit the testbed's deployment keeps on the operations machine |
| `docs/` | The documents, which come before the code: start with `docs/layout.md`, and read `docs/api.md` for the public API and `docs/openapi.json` for its machine form |
| `package/` | The TypeScript client generated from `docs/openapi.json` |
| `runtime/` | The GGUF engine's unit templates and node setup (`docs/gguf-llm.md`) |
| `src/` | The root package: the version, the `gate-server` binary and the `bmo-gate` unit command |
| `tests/` | Every test of the repository |
| `tools/` | The tools a tool host places: the translator's tool, `gate/translate`, and the brain's index tool, `gate/reference_index`, `gate/reference_piece` and `gate/reference_search`, each with its manifest, schemas, manual and executable |
| `training/` | The tooling the deployment runs on the operations machine: a Bun project of its own, which places a GGUF model on a node (`docs/gguf-llm.md`) |

`PERSONAL-DATA.md` states the personal data no file may hold: whose it is, what counts, where a value belongs
instead, and the check that holds it.

## Checking a change

- `cargo check --workspace --all-targets` — the static check.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` — the review.
- `cargo test` — every test, the repository checks among them. The personal-data check is the testbed's quick
  check, enabled in the declaration.

## Version

The version stands in `VERSION` and in the workspace manifest, which hold the same number. It moves only at a
release the owner declares, as bmo-chat's `docs/conventions.md` 「Versions」 states; a commit, a deploy, a fix or a
contract change moves none, and a deployment is told apart by its commit.

## License

MIT. The licence text stands in `LICENSE`, and every manifest declares the same licence.
