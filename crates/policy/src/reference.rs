//! What a turn is handed with no pick (docs/reference-selection.md): how much it may carry together, how much of a
//! speaker's sheet attaches, and how many due memories it carries.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
  /// What a turn may carry together, in characters.
  pub turn_budget_chars: usize,
  /// What a person's sheet may hold where it attaches, in characters.
  pub sheet_chars: usize,
  /// How many fact lines of a speaker's sheet attach as its head, every name line carried ahead of them.
  pub sheet_lines: usize,
  /// What the org sheet may hold, in characters.
  pub organisation_chars: usize,
  /// How many of a room's due memories attach.
  pub due: usize,
  /// How long a standing row's line in the brain's index runs, in characters.
  pub index_chars: usize,
  /// What the rows a turn's events wake may come to, in characters.
  pub woken_budget: usize,
}

crate::part!(pub REFERENCE: Reference = "reference.toml");
