//! A turn's reference on the road: the room's due memories, the heads of the speakers' sheets and the rows the turn's
//! events wake, held to the turn's total, with no model asked.

use gate_policy::reference::REFERENCE;
use gate_ports::brain::{Event, Sheet};
use gate_reference::road::{Turn, handed, held_sheet};
use gate_reference::{Entry, SituationTurn, Source};

use super::{Ground, ground};
use crate::reference::fakes::memory;

fn turn() -> Turn {
  Turn {
    chat_id: 7,
    message_id: Some(9),
    speaker_ids: vec![5, 5],
    situation: None,
  }
}

// A room's memories: errands whose event came at different moments, one more of them than the due count, and rows
// waiting on nothing.
fn furnish_memories(ground: &Ground) {
  let mut rows: Vec<_> = (0..=REFERENCE.due as i64)
    .map(|at| {
      let mut row = memory(40 + at, "promise", "", "Tell them once the job ends.");

      row.event_met_at = Some(100 + at);
      row
    })
    .collect();

  rows.extend((51..=54).map(|id| memory(id, "followup", "", &format!("Follow up on matter {id}."))));
  *ground.brain.standing.lock().unwrap() = rows;
}

// The numbers of the rows an entry carries, in its order.
fn carried(entry: &Entry) -> Vec<i64> {
  entry
    .text
    .lines()
    .filter_map(|line| line.strip_prefix("- #"))
    .filter_map(|line| line.split_whitespace().next())
    .filter_map(|id| id.parse().ok())
    .collect()
}

fn memories_of(entries: &[Entry]) -> Option<&Entry> {
  entries.iter().find(|entry| entry.path == "memories/7")
}

#[tokio::test]
async fn a_turn_carries_its_due_memories_the_speakers_sheet_head_and_the_woken_rows_and_asks_no_model() {
  let ground = ground("core", |_| Some("yes".into())).await;

  furnish_memories(&ground);
  ground.brain.sheets.lock().unwrap().push(long_sheet(5, 30));
  ground
    .brain
    .woken
    .lock()
    .unwrap()
    .push(memory(1, "situation", "on-deploy", "watch the deploy"));

  let woken = Turn {
    situation: Some(SituationTurn {
      chat_id: 7,
      agent: "the-chat-agent".into(),
      events: vec![Event {
        kind: "job-done".into(),
        item: Some(3),
      }],
    }),
    ..turn()
  };
  let entries = handed(&ground.reference, &woken).await;
  let due = REFERENCE.due as i64;

  assert_eq!(
    entries.iter().map(|entry| (entry.path.as_str(), entry.source)).collect::<Vec<_>>(),
    [
      ("memories/7", Source::Memory),
      ("rooms/7/people/5/sheet.md", Source::Person),
      ("situation-rule/on-deploy", Source::Situation),
    ]
  );

  let memories = memories_of(&entries).unwrap();

  assert_eq!(carried(memories), (1..=due).rev().map(|at| 40 + at).collect::<Vec<_>>());
  assert!(memories.text.contains(&format!("of the {} open items", due + 5)));
  assert!(
    memories
      .text
      .ends_with("- … 5 more open here, not carried this turn: brain_list with chat 7")
  );

  let head = entries.iter().find(|entry| entry.path == "rooms/7/people/5/sheet.md").unwrap();

  assert_eq!(head.text.lines().count(), REFERENCE.sheet_lines);
  assert_eq!(head.text.lines().next(), Some("- [#1 since 2026-01-02] Fact 1."));
  assert!(ground.gateway.asked.lock().unwrap().is_empty(), "no model is asked");
}

#[tokio::test]
async fn nothing_due_carries_no_memories_entry() {
  let quiet = ground("memories-none", |_| None).await;

  quiet.brain.standing.lock().unwrap().push(memory(51, "followup", "", "Follow up."));

  assert!(memories_of(&handed(&quiet.reference, &turn()).await).is_none());
}

#[test]
fn a_sheet_over_its_ceiling_keeps_its_lines_from_the_top() {
  let line = |at: usize| format!("- [#{at} since 2026-01-02] {}", "x".repeat(990));
  let text = (1..=40).map(line).collect::<Vec<_>>().join("\n");
  let held = held_sheet(&text);
  let lines: Vec<&str> = held.split('\n').collect();

  assert!(held.chars().count() <= REFERENCE.sheet_chars);
  assert_eq!(lines[0], line(1));
  assert_eq!(*lines.last().unwrap(), line(lines.len()));
  assert!(held.chars().count() + line(lines.len() + 1).chars().count() + 1 > REFERENCE.sheet_chars);
  assert_eq!(held_sheet("- [#1 since 2026-01-02] Short.\n"), "- [#1 since 2026-01-02] Short.");
  assert_eq!(held_sheet(&"x".repeat(REFERENCE.sheet_chars + 1)), "");
}

// A speaker's sheet of so many facts, one line each.
fn long_sheet(person: i64, facts: usize) -> Sheet {
  Sheet {
    person,
    path: format!("rooms/7/people/{person}/sheet.md"),
    text: (1..=facts)
      .map(|at| format!("- [#{at} since 2026-01-02] Fact {at}."))
      .collect::<Vec<_>>()
      .join("\n"),
  }
}
