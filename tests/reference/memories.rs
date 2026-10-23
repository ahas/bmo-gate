//! The standing entry: each row's line in Korean time with its parts, the rows within the allowance, and the line on
//! those too long to carry.

use gate_policy::memories::MEMORIES;
use gate_reference::memories::{memory_line, memory_path, standing_entry};

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
fn the_entry_carries_what_fits_and_says_how_many_more_stand() {
  let long = "x".repeat(MEMORIES.budget_chars);
  let rows = [memory(1, "promise", "a", "call back"), memory(2, "state", "b", &long)];
  let entry = standing_entry(7, &rows).unwrap();

  assert_eq!(entry.path, memory_path(7));
  assert!(entry.text.contains("2 open items"));
  assert!(entry.text.contains("- #1 promise"));
  assert!(!entry.text.contains(&long));
  assert!(
    entry
      .text
      .ends_with("- … 1 more open, too long to carry this turn: brain_list with chat 7")
  );
  assert!(standing_entry(7, &[]).is_none());
}
