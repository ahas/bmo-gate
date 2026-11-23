//! What an organisation hands its members (docs/reference-selection.md, 「What an organisation hands its members」):
//! the lines the org sheet is written in and the words of the index's organisation group. How much the sheet holds
//! stands in `crate::reference`.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SheetLines {
  pub head: String,
  pub line: String,
  pub locked: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndexWords {
  pub holds: String,
  pub piece: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Organisation {
  /// The name the platform's base goes by.
  pub base: String,
  pub sheet: SheetLines,
  pub index: IndexWords,
}

crate::part!(pub ORGANISATION: Organisation = "organisation.toml");
