//! The fragment rows the brain's index lists (`docs/reference-selection.md`, 「The index an agent reads」): the rows a
//! turn's agent's own brain holds for a room.

use std::sync::atomic::{AtomicI64, Ordering};

use gate_ports::PortError;
use gate_ports::brain::{self, BrainKey};

use crate::Reference;

/// One fragment row as the index lists it, under a number the service tells it apart by.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fragment {
  pub id: i64,
  /// The brain's own key for the row, which a hit names it by.
  pub key: String,
  pub kind: String,
  pub chat_id: Option<i64>,
  pub owner: Option<i64>,
  pub slug: String,
  pub title: String,
  pub path: String,
  pub scope: Option<String>,
  /// The heading of the brain's table of contents the row stands under, where its library has headings.
  pub section: Option<String>,
  pub position: i64,
  pub keywords: Vec<String>,
  pub items: Vec<i64>,
  pub written_on: Option<String>,
  pub confirmed_on: Option<String>,
  pub status: String,
  /// The row's whole text where its library carries it rather than reading it through the brain.
  pub body: Option<String>,
}

// The numbers rows are told apart by in this service.
static NEXT: AtomicI64 = AtomicI64::new(1);

impl Fragment {
  /// A row as the brain answers it, under a number of its own.
  pub fn of(row: brain::Fragment) -> Self {
    Self {
      id: NEXT.fetch_add(1, Ordering::Relaxed),
      key: row.key,
      kind: row.kind,
      chat_id: row.chat_id,
      owner: row.owner,
      slug: row.slug,
      title: row.title,
      path: row.path,
      scope: row.scope,
      section: row.section,
      position: row.position,
      keywords: row.keywords,
      items: row.items,
      written_on: row.written_on,
      confirmed_on: row.confirmed_on,
      status: row.status,
      body: None,
    }
  }
}

/// The active rows of one kind the turn's agent's own brain, `key`, offers in the room, in the order the brain gives
/// them.
pub async fn rows(
  reference: &Reference,
  key: &BrainKey,
  chat_id: i64,
  kind: &str,
) -> Result<Vec<Fragment>, PortError> {
  let kinds = [kind.to_owned()];
  let rows = reference.brain.offered(key, chat_id, &kinds).await?;

  Ok(rows.into_iter().filter(|row| row.kind == kind).map(Fragment::of).collect())
}
