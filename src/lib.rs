//! The gate stage of a turn, as one service: the reference a turn is handed, the translator, and the judgements
//! and road records it keeps (`docs/layout.md`).

/// The version this build answers with: the set's version the build was made at, which the testbed hands the
/// build as `BMO_VERSION`, else the manifest's placeholder (bmo-chat's `docs/conventions.md`, 「Versions」).
pub const VERSION: &str = match option_env!("BMO_VERSION") {
  Some(version) => version,
  None => env!("CARGO_PKG_VERSION"),
};
