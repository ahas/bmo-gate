//! A turn's reference on the road: the room's due memories, the heads of the speakers' sheets, the holders' sheet of
//! what a holder left in the agent's brain and the rows the turn's events wake, held to the turn's total, with no
//! model asked.

use gate_policy::reference::REFERENCE;
use gate_ports::audience::Audience;
use gate_ports::brain::{Event, Sheet};
use gate_reference::holders::{KEYED_PATH, SHEET_PATH};
use gate_reference::road::{Turn, handed, held_sheet};
use gate_reference::{Entry, SituationTurn, Source};

use super::{Ground, ground};
use crate::reference::fakes::{held_row, memory};

fn turn() -> Turn {
  Turn {
    chat_id: 7,
    message_id: Some(9),
    speaker_ids: vec![5, 5],
    agent: "the-chat-agent".into(),
    audience: Audience::Internal,
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

// The holders' sheet a turn was handed.
fn holders_sheet(entries: &[Entry]) -> &Entry {
  entries
    .iter()
    .find(|entry| entry.path == SHEET_PATH)
    .expect("a turn is handed the holders' sheet")
}

// The holder and row number each line of a sheet names, in the order they stand.
fn held_marks(text: &str) -> Vec<String> {
  text
    .lines()
    .skip(1)
    .filter_map(|line| line.strip_prefix("- ["))
    .filter_map(|line| line.split_once("] ").map(|(mark, _)| mark.to_owned()))
    .collect()
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
  assert!(
    memories
      .text
      .contains(&format!("{} open items, due now or bearing on this turn", due + 5))
  );
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

#[tokio::test]
async fn a_turn_is_handed_a_held_row_whose_words_say_nothing_of_the_turn() {
  let ground = ground("holders-beside-sheets", |_| Some("yes".into())).await;

  furnish_memories(&ground);
  ground.brain.sheets.lock().unwrap().push(long_sheet(5, 30));
  ground.brain.held_rows.lock().unwrap().push(held_row(
    900,
    "holder-a",
    "rule-1",
    "Say nothing of a deploy before its notice.",
  ));

  let entries = handed(&ground.reference, &turn()).await;

  assert_eq!(
    entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(),
    ["memories/7", "rooms/7/people/5/sheet.md", SHEET_PATH]
  );

  let held = holders_sheet(&entries);

  assert_eq!(held.source, Source::Memory);
  assert_eq!(
    held.text.lines().skip(1).collect::<Vec<_>>(),
    ["- [holder-a #900] Say nothing of a deploy before its notice."]
  );
}

#[tokio::test]
async fn held_rows_stand_on_a_turn_that_holds_nothing_else() {
  let quiet = ground("holders-alone", |_| None).await;

  quiet.brain.held_rows.lock().unwrap().push(held_row(
    901,
    "holder-a",
    "rule-1",
    "Answer in the room's own language.",
  ));

  let entries = handed(&quiet.reference, &turn()).await;

  assert_eq!(entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(), [SHEET_PATH]);
}

#[tokio::test]
async fn the_holders_sheet_leaves_out_a_row_that_does_not_fit_whole() {
  let ground = ground("holders-ceiling", |_| None).await;
  let over = format!("{}ends.", "longw".repeat(REFERENCE.holder_chars / 2));

  ground.brain.held_rows.lock().unwrap().extend([
    held_row(910, "holder-a", "rule-1", "One short standing rule."),
    held_row(911, "holder-b", "rule-1", &over),
  ]);

  let handed = handed(&ground.reference, &turn()).await;
  let held = holders_sheet(&handed);
  let lines: Vec<&str> = held.text.lines().collect();

  assert_eq!(lines.len(), 2, "only the row that fits stands, and stands whole");
  assert_eq!(lines[1], "- [holder-a #910] One short standing rule.");
  assert!(!held.text.contains("longw"), "a row over the ceiling is not cut in half");
  assert!(held.text.chars().count() <= REFERENCE.holder_chars);
}

#[tokio::test]
async fn the_holders_sheet_orders_its_rows_by_holder_then_key_then_number() {
  let ground = ground("holders-order", |_| None).await;

  ground.brain.held_rows.lock().unwrap().extend([
    held_row(930, "holder-b", "alpha", "The second holder's rule."),
    held_row(921, "holder-a", "beta", "The first holder's other rule."),
    held_row(920, "holder-a", "alpha", "The first holder's rule."),
    held_row(911, "holder-a", "alpha", "The first holder's first rule."),
  ]);

  assert_eq!(
    held_marks(&holders_sheet(&handed(&ground.reference, &turn()).await).text),
    ["holder-a #911", "holder-a #920", "holder-a #921", "holder-b #930"]
  );
}

#[tokio::test]
async fn the_rows_keyed_to_the_turns_room_and_notices_are_fetched_by_those_keys_into_their_own_sheet() {
  let keyed_ground = ground("holders-keyed", |_| None).await;

  keyed_ground.brain.keyed_rows.lock().unwrap().push(held_row(
    940,
    "receiver",
    "room-7.tone",
    "In this room answer in short lines.",
  ));

  let mut keyed_turn = turn();
  keyed_turn.situation = Some(SituationTurn {
    chat_id: 7,
    agent: "the-chat-agent".into(),
    events: vec![
      Event {
        kind: "job-review".into(),
        item: Some(12),
      },
      Event {
        kind: "job-review".into(),
        item: Some(13),
      },
    ],
  });
  let entries = handed(&keyed_ground.reference, &keyed_turn).await;

  assert_eq!(
    keyed_ground.brain.triggers_asked.lock().unwrap().last().cloned().unwrap_or_default(),
    ["room:7", "job-review"],
    "the room's key and each notice's kind, once"
  );
  let keyed = entries.iter().find(|entry| entry.path == KEYED_PATH).expect("the keyed sheet stands");
  assert_eq!(
    keyed.text.lines().skip(1).collect::<Vec<_>>(),
    ["- [receiver #940] In this room answer in short lines."]
  );

  // A turn in a room nothing is keyed to carries no keyed sheet, and still asks by the room's key.
  let empty = ground("holders-keyed-none", |_| None).await;
  let none = handed(&empty.reference, &turn()).await;
  assert!(none.iter().all(|entry| entry.path != KEYED_PATH));
  assert_eq!(
    empty.brain.triggers_asked.lock().unwrap().last().cloned().unwrap_or_default(),
    ["room:7"]
  );
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
