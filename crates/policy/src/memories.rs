//! The memories a turn is handed (docs/reference-selection.md): the lines their entry is written in. How many due
//! rows it carries is `crate::reference`'s; the rows themselves, their conditions and their
//! withering are the brain's.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryLines {
  pub opening: String,
  pub item_one: String,
  pub item_many: String,
  pub quiet: String,
  pub check_off: String,
  pub state: String,
  pub line: String,
  pub moved: String,
  pub for_user: String,
  pub from_item: String,
  pub more: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Memories {
  pub entry: EntryLines,
}

crate::part!(pub MEMORIES: Memories = "memories.toml");
