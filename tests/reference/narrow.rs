//! The narrowing's readings of a turn: the items it names, the words it carries, and the day a finished piece
//! still counts from. Hangul is written by its escapes.

use gate_reference::narrow::{items_asked, recent_since_of, words_carried};

#[test]
fn an_item_is_named_by_its_mark_its_word_or_as_one() {
  assert_eq!(items_asked("see #758 and 123\u{bc88} and 45 \u{bc88}\u{d638}"), vec![758, 123]);
  assert_eq!(items_asked("\u{d56d}\u{baa9} #77, then 123456\u{bc88}"), vec![77]);
}

#[test]
fn a_latin_word_is_carried_whole_and_a_korean_one_where_it_stands() {
  let text = "the rules of herdr\u{c5d0}\u{c11c}";

  assert_eq!(words_carried(&["rule".into()], text), 0);
  assert_eq!(words_carried(&["rules".into(), "herdr".into()], text), 2);
  assert_eq!(words_carried(&["\u{c5d0}\u{c11c}".into()], text), 1);
}

#[test]
fn the_recent_day_is_three_days_back_in_korean_time() {
  assert_eq!(recent_since_of(1_760_000_000_000), "2025-10-06");
}
