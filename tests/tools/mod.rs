//! The tools' test: each tool under `tools/` read by its manifest against its folder, the crate building its
//! executable and the testbed's declaration placing it, and the translator's tool's calls answered against a
//! stand-in gate on the loopback (`docs/api.md`, 「The tools a tool host places」).

mod manifest;
mod reference;
mod translate;
