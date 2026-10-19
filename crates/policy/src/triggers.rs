//! The words that make it worth asking the sanitiser at all: a pre-filter that errs towards asking. They stand in
//! `prompts/sanitizer/triggers.toml`, since they are matched against the rooms' own words, in the rooms' language.

use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Triggers {
  /// Each a pattern, matched case-insensitively: a word in the rooms' language as a substring, an English one with
  /// its word boundaries.
  pub patterns: Vec<String>,
}

pub static TRIGGERS: LazyLock<Triggers> = LazyLock::new(|| {
  crate::read(
    "prompts/sanitizer/triggers.toml",
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../prompts/sanitizer/triggers.toml")),
  )
});
