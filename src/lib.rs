//! The gate stage of a turn, as one service: what a turn's words are sanitised to, the reference a turn is
//! handed, the output gate, the translator, and Laya, the decision filter some gates ask first
//! (`docs/layout.md`).

/// The version this build answers with, the one `VERSION` at the root holds.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
