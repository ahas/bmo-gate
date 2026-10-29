//! The gate stage of a turn, as one service: the reference a turn is handed, the translator, and the judgements
//! and road records it keeps (`docs/layout.md`).

/// The version this build answers with, the one `VERSION` at the root holds.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
