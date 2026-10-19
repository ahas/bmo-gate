//! What an agent holds in a room as its turn reads it (the brain's `docs/memories.md`): every read is one agent's
//! rows, answered by the brain. A row carrying no condition stands in front of the turn as it is — the standing
//! entry, written here — and one carrying a condition is the matcher's candidate; a row waiting on an event
//! attaches by the event alone. The brain withers the rows that waited too long, releases a state nobody moved,
//! stamps an errand an event met and counts each match; the gate reads and writes back what it matched.

use chrono::{FixedOffset, TimeZone};
use gate_markup::js;
use gate_policy::fill_marks;
use gate_policy::memories::MEMORIES;
use gate_ports::PortError;
use gate_ports::brain::{Condition, Event, MemoryRow};

use crate::{Entry, Reference, Source};

// A moment as a row's line writes it, in Korean time to the minute, as the entry's line names it.
fn written(epoch_seconds: i64) -> String {
  FixedOffset::east_opt(9 * 3_600)
    .and_then(|seoul| seoul.timestamp_opt(epoch_seconds, 0).single())
    .map_or_else(String::new, |moment| moment.format("%Y-%m-%d %H:%M").to_string())
}

/// One standing row as its line in the entry: its number, its kind, when it was written and moved, whom it is
/// for, the item it was left open by, and what it asks.
pub fn memory_line(memory: &MemoryRow) -> String {
  let lines = &MEMORIES.entry;
  let moved = memory
    .moved_at
    .map_or_else(String::new, |at| fill_marks(&lines.moved, &[("at", &written(at))]));
  let for_whom = memory
    .for_user
    .map_or_else(String::new, |user| fill_marks(&lines.for_user, &[("user", &user.to_string())]));
  let from = memory
    .todo_id
    .map_or_else(String::new, |item| fill_marks(&lines.from_item, &[("item", &item.to_string())]));

  fill_marks(
    &lines.line,
    &[
      ("id", &memory.id.to_string()),
      ("type", &memory.kind),
      ("written", &written(memory.set_at)),
      ("moved", &moved),
      ("for", &for_whom),
      ("from", &from),
      ("action", &memory.action),
    ],
  )
}

/// Where a room's standing rows stand in a turn's log.
pub fn memory_path(chat_id: i64) -> String {
  format!("memories/{chat_id}")
}

/// The room's standing rows as one entry, oldest first and whole within the allowance, or none where it holds
/// none.
pub fn standing_entry(chat_id: i64, rows: &[MemoryRow]) -> Option<Entry> {
  let lines = &MEMORIES.entry;
  let mut shown = vec![];
  let mut taken = 0;

  for memory in rows {
    let line = memory_line(memory);
    let size = js::units(&line);

    if taken + size > MEMORIES.budget_chars {
      eprintln!(
        "memories: chat {chat_id} passes over #{} at {size} characters, which does not fit what is left of its {}",
        memory.id, MEMORIES.budget_chars
      );
      continue;
    }

    taken += size;
    shown.push(line);
  }

  if shown.is_empty() {
    return None;
  }

  let chat = chat_id.to_string();
  let count = rows.len().to_string();
  let items = if rows.len() == 1 { &lines.item_one } else { &lines.item_many };
  let mut text = vec![
    fill_marks(&lines.opening, &[("count", &count), ("items", items)]),
    lines.quiet.clone(),
    fill_marks(&lines.check_off, &[("chat", &chat)]),
  ];

  if rows.iter().any(|row| row.kind == "state") {
    text.push(lines.state.clone());
  }

  text.push(String::new());

  let more = rows.len() - shown.len();

  text.extend(shown);

  if more > 0 {
    text.push(fill_marks(&lines.more, &[("count", &more.to_string()), ("chat", &chat)]));
  }

  Some(Entry {
    path: memory_path(chat_id),
    text: text.join("\n"),
    source: Source::Memory,
    fragment: None,
  })
}

/// The room's standing rows as the brain answers them, as one entry; none where it holds none or they cannot be
/// read.
pub async fn standing(reference: &Reference, chat_id: i64, agent: &str) -> Option<Entry> {
  match reference.brain.standing(agent, chat_id).await {
    Ok(rows) => standing_entry(chat_id, &rows),
    Err(why) => {
      eprintln!("reference: chat {chat_id} memories could not be read: {why}");
      None
    }
  }
}

/// The rows a room's matcher is offered: its own and the global ones that reach it, each carrying a condition.
pub async fn candidates(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
) -> Result<Vec<Condition>, PortError> {
  reference.brain.conditions(agent, chat_id).await
}

/// The rows a turn's events wake that attach here by the event alone.
pub async fn woken(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
  events: &[Event],
) -> Result<Vec<MemoryRow>, PortError> {
  if events.is_empty() {
    return Ok(vec![]);
  }

  reference.brain.woken(agent, chat_id, events).await
}

/// What the matcher made of the room's rows, handed to the brain: the rows it matched and the rows it spent.
pub async fn matched(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
  applies: &[String],
  spent: &[String],
) -> Result<(), PortError> {
  if applies.is_empty() && spent.is_empty() {
    return Ok(());
  }

  reference.brain.matched(agent, chat_id, applies, spent).await
}
