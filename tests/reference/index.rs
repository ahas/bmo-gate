//! The index's titles split into what an entry holds and when it is read (`docs/reference-selection.md`, 「The index
//! an agent reads」).

use gate_reference::index::split_title;

#[test]
fn a_title_is_split_where_it_says_when_it_is_needed() {
  assert_eq!(
    split_title("how a deploy goes; needed when a deploy is asked about"),
    ("how a deploy goes".to_owned(), Some("needed when a deploy is asked about".to_owned()))
  );
  assert_eq!(
    split_title("the office cat; consulted only when the cat comes up"),
    ("the office cat".to_owned(), Some("consulted only when the cat comes up".to_owned()))
  );
  assert_eq!(split_title("the office cat"), ("the office cat".to_owned(), None));
  assert_eq!(split_title("a list; of things"), ("a list; of things".to_owned(), None));
}
