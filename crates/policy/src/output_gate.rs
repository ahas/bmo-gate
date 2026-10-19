//! The output gate's lines (docs/output-gate.md): the reason the structure check gives for each fault it
//! finds in a piece of markup, the line a case ends on where the message went plain, and how a decision Laya
//! or the gate's model did not make is written down. The question the fold puts to Laya is Laya's
//! (`crate::laya`).

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Faults {
  pub unescaped: String,
  pub unsupported: String,
  pub unclosed: String,
  pub unopened: String,
  pub crossed: String,
  pub nested: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decided {
  pub by_laya: String,
  pub by_fallback: String,
  pub laya_default: String,
  pub no_answer: String,
  pub unreadable: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputGateLines {
  pub went_plain: String,
  pub faults: Faults,
  pub decided: Decided,
}

crate::part!(pub OUTPUT_GATE: OutputGateLines = "output-gate.toml");
