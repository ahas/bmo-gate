//! What a holder leaves in an agent's brain as the turn reads it (the brain's `docs/design.md`, 「What a holder
//! leaves」; `docs/reference-selection.md`, 「What a turn is given」): every row a holder left in the turn's agent's
//! own brain stands on every turn of every room whatever the turn says, in one sheet held to its own ceiling. No
//! model is asked.

use gate_markup::js;
use gate_policy::fill_marks;
use gate_policy::holders::HOLDERS;
use gate_policy::reference::REFERENCE;
use gate_ports::brain::{BrainKey, HeldRow};

use crate::{Entry, Reference, Source};

/// The path the holders' sheet is handed under.
pub const SHEET_PATH: &str = "holders/sheet.md";

// One row's line of the sheet: its holder's key, the row's number, and its words on one line.
fn sheet_line(row: &HeldRow) -> String {
  let words = row.text.split_whitespace().collect::<Vec<_>>().join(" ");

  fill_marks(
    &HOLDERS.sheet.line,
    &[("holder", &row.holder), ("id", &row.id.to_string()), ("text", &words)],
  )
}

/// The holders' sheet: its head line, then one line a row, the holder's key first and the key the holder gave the
/// row and the row's number after it ordering them; each line stands whole or not at all, as the ceiling takes
/// them. None where no row stands or no line fits.
fn sheet(rows: &[HeldRow]) -> Option<Entry> {
  let mut order: Vec<&HeldRow> = rows.iter().collect();

  order.sort_by(|left, right| {
    left
      .holder
      .cmp(&right.holder)
      .then_with(|| left.key.cmp(&right.key))
      .then(left.id.cmp(&right.id))
  });

  let head = &HOLDERS.sheet.head;
  let mut used = js::units(head);
  let mut kept: Vec<String> = Vec::new();

  for row in order {
    let line = sheet_line(row);
    let cost = js::units(&line) + 1;

    if used + cost <= REFERENCE.holder_chars {
      used += cost;
      kept.push(line);
    }
  }

  if kept.is_empty() {
    return None;
  }

  Some(Entry {
    path: SHEET_PATH.to_owned(),
    text: std::iter::once(head.clone()).chain(kept).collect::<Vec<_>>().join("\n"),
    source: Source::Memory,
    fragment: None,
  })
}

/// The holders' sheet a turn carries, of what the turn's agent's own brain holds from a holder; none where the
/// agent keeps no brain, nothing stands, it cannot be read, or no line fits its ceiling.
pub async fn sheet_entry(reference: &Reference, chat_id: i64, key: &BrainKey) -> Option<Entry> {
  let rows = match reference.brain.held_rows(key).await {
    Ok(rows) => rows,
    Err(why) => {
      eprintln!("reference: chat {chat_id} what a holder left could not be read: {why}");
      return None;
    }
  };

  sheet(&rows)
}
