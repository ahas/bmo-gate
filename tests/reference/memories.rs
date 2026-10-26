//! The memories entry: each row's line in Korean time with its parts, the due rows parted from the rest, a row as the
//! memory picker's candidate, and the entry over the rows it carries with the line on those it does not.

use gate_policy::reference::REFERENCE;
use gate_reference::fragments::index_line;
use gate_reference::memories::{
  candidate, due_first, index_title, library, memories_entry, memory_line, memory_path, names,
};

use crate::fakes::memory;

#[test]
fn a_rows_line_is_written_in_korean_time_with_its_parts() {
  let mut row = memory(7, "state", "the-build", "the build runs");

  row.moved_at = Some(3_600);
  row.for_user = Some(5);
  row.todo_id = Some(12);

  let line = memory_line(&row);

  assert!(
    line.starts_with("- #7 state · written 1970-01-01 09:00 KST · moved 1970-01-01 10:00 KST"),
    "{line}"
  );
  assert!(line.contains(" · for user 5") && line.contains(" · left open by item #12"));
  assert!(line.ends_with(": the build runs"));
}

#[test]
fn the_due_rows_come_latest_first_up_to_their_count_and_the_rest_keep_the_brains_order() {
  let met = |id: i64, at: i64| {
    let mut row = memory(id, "promise", "", "tell them");

    row.event_met_at = Some(at);
    row
  };
  let mut rows = vec![memory(1, "followup", "", "ask again")];

  rows.extend((0..=REFERENCE.memories.due as i64).map(|at| met(10 + at, 100 + at)));
  rows.push(memory(2, "check", "", "look it up"));

  let (due, rest) = due_first(&rows);
  let latest: Vec<i64> = (0..REFERENCE.memories.due as i64).rev().map(|at| 11 + at).collect();

  assert_eq!(due.iter().map(|row| row.id).collect::<Vec<_>>(), latest);
  assert_eq!(rest.iter().map(|row| row.id).collect::<Vec<_>>(), [1, 10, 2]);
  assert!(due_first(&[]).0.is_empty());
}

#[test]
fn a_row_is_offered_by_its_kind_and_its_first_words_and_carries_its_line_as_its_body() {
  let mut row = memory(41, "promise", "call-back", "Call back once the deploy lands.\nThen close it.");

  row.for_user = Some(5);
  row.todo_id = Some(12);

  let offered = candidate(7, &row, "call-back");

  assert_eq!(index_line(&offered), "- call-back [promise] \u{2014} Call back once the deploy lands.");
  assert_eq!(offered.key, "41");
  assert_eq!((offered.owner, offered.items.clone()), (Some(5), vec![12]));
  assert_eq!(offered.path, format!("{}/41", memory_path(7)));
  assert_eq!(offered.body, Some(memory_line(&row)));

  let long = memory(42, "check", "", &"word ".repeat(100));
  let title = index_title(&long);

  assert!(title.ends_with('\u{2026}') && title.chars().count() <= REFERENCE.memories.index_chars);
  assert_eq!(index_title(&memory(43, "state", "", "")), "state");
}

#[test]
fn the_entry_carries_the_rows_given_and_says_how_many_more_stand() {
  let rows = [memory(1, "promise", "a", "call back"), memory(2, "state", "b", "the build runs")];
  let entry = memories_entry(7, 5, &[&rows[0], &rows[1]]).unwrap();

  assert_eq!(entry.path, memory_path(7));
  assert!(entry.text.contains("of the 5 open items"));
  assert!(entry.text.contains("- #1 promise") && entry.text.contains("- #2 state"));
  assert!(entry.text.contains("memory_update"));
  assert!(
    entry
      .text
      .ends_with("- … 3 more open here, not carried this turn: brain_list with chat 7")
  );
  assert!(memories_entry(7, 5, &[]).is_none());
}

#[test]
fn a_row_is_named_by_its_key_and_by_its_number_where_its_key_cannot_name_it() {
  let rows = [
    memory(1, "promise", "birthday-record", "Keep the birthday."),
    memory(2, "check", "", "Look it up."),
    memory(3, "check", "Not A Slug", "Look again."),
    memory(4, "state", "birthday-record", "The same key twice."),
    memory(5, "state", "memory-2", "Another row's number."),
    memory(6, "state", "memory-6", "Its own number."),
    memory(7, "state", "rain_check", "An underscore."),
  ];

  assert_eq!(
    names(&rows),
    [
      "birthday-record",
      "memory-2",
      "memory-3",
      "memory-4",
      "memory-5",
      "memory-6",
      "memory-7"
    ]
  );

  // The name the index offers a row under is the name it is read by, and its key stays the row's id.
  let offered = library(7, &rows).unwrap();
  let slugs: Vec<&str> = offered.rows.iter().map(|row| row.slug.as_str()).collect();
  let keys: Vec<&str> = offered.rows.iter().map(|row| row.key.as_str()).collect();

  assert_eq!(slugs, names(&rows));
  assert_eq!(keys, ["1", "2", "3", "4", "5", "6", "7"]);
  assert!(
    offered
      .index_text()
      .starts_with("- birthday-record [promise] \u{2014} Keep the birthday.\n- memory-2 [check]")
  );
}
