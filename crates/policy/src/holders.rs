//! What a holder leaves in an agent's brain (docs/reference-selection.md, 「What a turn is given」): the lines the
//! holders' sheet is written in. How much the sheet holds is `crate::reference`'s; the rows themselves, and their
//! standing beyond any change an agent or a person may make, are the brain's.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SheetLines {
  pub head: String,
  pub line: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Holders {
  pub sheet: SheetLines,
}

crate::part!(pub HOLDERS: Holders = "holders.toml");
