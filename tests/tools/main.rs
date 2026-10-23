//! The tools' test: each tool under `tools/` read by its manifest against its folder, the crate building its
//! executable and the testbed's declaration placing it, and the translator's tool's calls answered against a
//! stand-in gate on the loopback (`docs/api.md`, 「The tool a tool host places」).

#[path = "../support/stub.rs"]
mod stub;

mod manifest;
mod translate;
