//! What an agent holds in a room as its turn reads it (the brain's `docs/memories.md`;
//! `docs/reference-selection.md`): every read is one agent's rows, answered by the brain. A row carrying no
//! condition stands in its room, and the errands whose event has come attach as due, a few of them, in one entry;
//! a row waiting on an event attaches by the event alone. The brain withers the rows that waited too long, releases
//! a state nobody moved and stamps an errand an event met.

use chrono::{FixedOffset, TimeZone};
use gate_markup::js;
use gate_policy::fill_marks;
use gate_policy::memories::MEMORIES;
use gate_policy::reference::REFERENCE;
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

/// Whether a standing row is due: an errand whose event has come.
pub fn is_due(memory: &MemoryRow) -> bool {
  memory.event_met_at.is_some()
}

/// A room's standing rows parted: the due ones that attach, the latest come first and at most the policy's count of
/// them, and the rest in the order the brain lists them, a due row past the count among them.
pub fn due_first(rows: &[MemoryRow]) -> (Vec<MemoryRow>, Vec<MemoryRow>) {
  let mut due: Vec<&MemoryRow> = rows.iter().filter(|memory| is_due(memory)).collect();

  due.sort_by(|left, right| right.event_met_at.cmp(&left.event_met_at).then(right.id.cmp(&left.id)));
  due.truncate(REFERENCE.due);

  let attached: Vec<i64> = due.iter().map(|memory| memory.id).collect();
  let rest = rows.iter().filter(|memory| !attached.contains(&memory.id)).cloned().collect();

  (due.into_iter().cloned().collect(), rest)
}

/// What a row's index line says of it: the first line of its words, cut to the policy's length with `…`; its kind
/// where it has no words.
pub fn index_title(memory: &MemoryRow) -> String {
  let first = memory
    .action
    .split(['\n', '\r', '\u{2028}', '\u{2029}'])
    .map(js::trim)
    .find(|line| !line.is_empty())
    .unwrap_or(&memory.kind);
  let characters = js::chars(first);
  let limit = REFERENCE.index_chars;

  if js::units(first) <= limit {
    return first.to_owned();
  }

  format!("{}\u{2026}", js::trim_end(&js::text(&characters[..js::within(&characters, limit - 1)])))
}

/// The memories entry: the head naming the rows that follow, with `open` the rows the room holds, the carried rows'
/// lines in the order given, and the line on the rows not carried; none where no row is carried. The entry carries
/// data alone; how a turn reads it stands in the room's block.
pub fn memories_entry(chat_id: i64, open: usize, carried: &[&MemoryRow]) -> Option<Entry> {
  if carried.is_empty() {
    return None;
  }

  let lines = &MEMORIES.entry;
  let chat = chat_id.to_string();
  let count = open.to_string();
  let items = if open == 1 { &lines.item_one } else { &lines.item_many };
  let mut text = vec![fill_marks(&lines.opening, &[("count", &count), ("items", items)])];

  text.push(String::new());
  text.extend(carried.iter().map(|memory| memory_line(memory)));

  let more = open.saturating_sub(carried.len());

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

/// The room's standing rows as the brain answers them: the rows that wait on nothing and the errands whose event
/// has come; none where they cannot be read.
pub async fn standing(reference: &Reference, chat_id: i64, agent: &str) -> Vec<MemoryRow> {
  match reference.brain.standing(agent, chat_id).await {
    Ok(rows) => rows,
    Err(why) => {
      eprintln!("reference: chat {chat_id} memories could not be read: {why}");
      vec![]
    }
  }
}

/// A room's standing rules: its own rows and the global ones that reach it, each carrying a condition.
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
