//! What a holder leaves in an agent's brain as the turn reads it (the brain's `docs/design.md`, 「What a holder
//! leaves」; `docs/reference-selection.md`, 「What a turn is given」): every row a holder left to stand on every
//! turn stands in one sheet held to its own ceiling, and the rows keyed to what the turn meets — its room, the
//! kinds of the notices it carries — are fetched by those keys into a sheet of their own. No model is asked.

use gate_markup::js;
use gate_policy::fill_marks;
use gate_policy::holders::HOLDERS;
use gate_policy::reference::REFERENCE;
use gate_ports::brain::{BrainKey, Event, HeldRow};

use crate::{Entry, Reference, Source};

/// The path the holders' sheet is handed under.
pub const SHEET_PATH: &str = "holders/sheet.md";

/// The path the sheet of the rows keyed to what the turn meets is handed under.
pub const KEYED_PATH: &str = "holders/keyed.md";

/// The trigger a room's own guidance is keyed by, as the callers agree to spell it.
pub fn room_trigger(chat_id: i64) -> String {
  format!("room:{chat_id}")
}

/// The triggers a turn meets: its room, and the kind of each event it carries, each once in that order.
pub fn turn_triggers(chat_id: i64, events: &[Event]) -> Vec<String> {
  let mut triggers = vec![room_trigger(chat_id)];

  for event in events {
    if !triggers.contains(&event.kind) {
      triggers.push(event.kind.clone());
    }
  }

  triggers
}

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
fn sheet(rows: &[HeldRow], head: &str, path: &str) -> Option<Entry> {
  let mut order: Vec<&HeldRow> = rows.iter().collect();

  order.sort_by(|left, right| {
    left
      .holder
      .cmp(&right.holder)
      .then_with(|| left.key.cmp(&right.key))
      .then(left.id.cmp(&right.id))
  });

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
    path: path.to_owned(),
    text: std::iter::once(head.to_owned()).chain(kept).collect::<Vec<_>>().join("\n"),
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

  sheet(&rows, &HOLDERS.sheet.head, SHEET_PATH)
}

/// The sheet of the rows a holder keyed to what the turn meets, read by the turn's triggers; none where nothing is
/// keyed to them, it cannot be read, or no line fits the ceiling.
pub async fn keyed_entry(
  reference: &Reference,
  chat_id: i64,
  key: &BrainKey,
  events: &[Event],
) -> Option<Entry> {
  let triggers = turn_triggers(chat_id, events);
  let rows = match reference.brain.keyed_rows(key, &triggers).await {
    Ok(rows) => rows,
    Err(why) => {
      eprintln!("reference: chat {chat_id} what a holder keyed to this turn could not be read: {why}");
      return None;
    }
  };

  sheet(&rows, &HOLDERS.keyed.head, KEYED_PATH)
}
