# Working in bmo-gate

These rules hold every change to this repository.

## The documents come first

- `docs/` is the canonical statement of what the gate does; the code is one realisation of it. Before
  changing code, read the document covering that area, `docs/layout.md` first.
- A change that would make a document wrong or incomplete repairs the document first, stating what is true now,
  and the code is written to match.
- A document states what is true now: no change history, no rationale told through an earlier design, no pasted
  source, signature or config fragment, and no file-and-line pins.

## Boundaries

- **Other units are reached only through their published routes and commands,** as
  `docs/boundary-api.md` states. Nothing here imports another unit's code or reads its files, its paths or its
  database.
- **Dependencies:** crates and packages from their registries, pinned in their manifests, and of other
  repositories only the base libraries `bmo-chat`, `bmo-chat-client` and `bmo-ui`. The repository test
  in `tests/` holds this for Cargo, Bun and Python manifests alike.
- **No agent is known by name.** The code handles a registered agent by its id; its name, label and persona come
  from the registration.
- **No lookup table standing in for polymorphism,** and no hand-written parser for a general format:
  TOML, YAML, JSON, markdown, command lines and their kin are read by a maintained library.

## Language

- Everything in this repository is English: code, comments, strings, tests, documents, commit messages
  and branch names, with the one exception below.
- Korean stands only in what a test feeds the code, a pattern reads or a bench sends as a sample state, written
  by its unicode escapes and recorded in `korean-ledger.json`, which the testbed's language check reads. Nothing
  else holds Korean.
- No personal data: no user names, home directories, machine names, domains, network addresses or names
  of any agent. What the gate needs at runtime comes from its settings and the other units' answers.
  Tests and documents use neutral names.

## Layout

- One Cargo manifest at the root. Bun and Python projects keep their manifests in their own folders.
- No directory named after its parent. The README's folder table names every top-level folder that
  stands, and a change adding one adds its row.
- Tests live in `tests/`, never beside the code they test (`docs/layout.md`).
- Weights, datasets and run output never enter git.

## The stages of a change

1. **Writing:** the only check is `cargo check --workspace --all-targets`; `bunx tsc --noEmit` in a
   changed Bun project; `python3 -m py_compile` on a changed Python file.
2. **Review:** read the whole diff against the document governing it, then `cargo fmt --all --check`
   and `cargo clippy --workspace --all-targets -- -D warnings`.
3. **Verification:** the test targets touched, then `cargo test` once, output written to a file and the
   file read.

A change is not done before stage 3 has passed.
