//! The narrowing's readings of a turn: the items it names, the words it carries, and the day a finished piece
//! still counts from; and what it keeps of a library — a piece whose words the turn carries, a piece about a person in
//! the turn, a piece the gate just attached, and no more than a gate's cap. Hangul is written by its escapes.

use std::collections::HashMap;

use gate_reference::fragments::Fragment;
use gate_reference::narrow::{
  GATE_CAP, KeptBy, Turn, Word, content_words, items_asked, narrow, recent_since_of, words_carried,
};
use gate_reference::road::spoken;

use crate::fakes::fragment;

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

const NOW: i64 = 1_760_000_000_000;

// A piece of a kind about nobody, under its slug and title.
fn piece(slug: &str, title: &str) -> Fragment {
  Fragment::of(fragment("library-knowledge", slug, title, None, None))
}

fn said(text: &str) -> Turn {
  Turn {
    text: text.to_owned(),
    said: text.to_owned(),
    speakers: vec![],
    names: HashMap::new(),
    recent_since: Some(recent_since_of(NOW)),
    attached: HashMap::new(),
    rules: None,
  }
}

fn slugs(rows: &[Fragment]) -> Vec<&str> {
  rows.iter().map(|row| row.slug.as_str()).collect()
}

#[test]
fn a_content_word_of_english_is_three_letters_or_more_and_not_a_common_one() {
  assert_eq!(
    content_words("How do the deploys go, Robin? Version v2"),
    [
      Word::Latin("deploys".into()),
      Word::Latin("robin".into()),
      Word::Latin("version".into())
    ]
    .into()
  );
}

#[test]
fn the_narrowing_keeps_a_piece_whose_words_the_turn_carries_and_drops_one_it_does_not() {
  let rows = [piece("deploy-notes", "how a deploy goes"), piece("kittens", "the office cat")];
  let narrowed = narrow(&rows, &said("how do deploys go?"));

  assert_eq!(slugs(&narrowed.rows), ["deploy-notes"]);
  assert_eq!((narrowed.held, narrowed.kept.word, narrowed.kept.person, narrowed.capped), (2, 1, 0, 0));
}

#[test]
fn a_piece_about_nobody_is_not_kept_for_being_about_nobody() {
  let rows = [piece("harbour", "the harbour"), piece("weather", "the town's weather")];

  assert!(narrow(&rows, &said("good morning")).rows.is_empty());
}

#[test]
fn a_korean_word_is_matched_with_its_particle_on_either_side() {
  // 배포를 끝낸 뒤 · 배포 순서 · 고양이 · 문서
  let rows = [
    piece("deploy-after", "\u{bc30}\u{d3ec}\u{b97c} \u{b05d}\u{b0b8} \u{b4a4}"),
    piece("deploy-order", "\u{bc30}\u{d3ec} \u{c21c}\u{c11c}"),
    piece("cat", "\u{ace0}\u{c591}\u{c774}"),
    piece("documents", "\u{bb38}\u{c11c}"),
  ];
  // 배포는 언제 해? 고양이가 봤어
  let narrowed = narrow(
    &rows,
    &said(
      "\u{bc30}\u{d3ec}\u{b294} \u{c5b8}\u{c81c} \u{d574}? \u{ace0}\u{c591}\u{c774}\u{ac00} \u{bd24}\u{c5b4}",
    ),
  );

  assert_eq!(slugs(&narrowed.rows), ["deploy-after", "deploy-order", "cat"]);
}

#[test]
fn a_word_most_of_a_library_carries_keeps_nothing() {
  let rows: Vec<Fragment> = (0..8)
    .map(|at| piece(&format!("notes-{at}"), &format!("the deploy notes, part {at}")))
    .collect();

  assert!(narrow(&rows, &said("the deploy notes")).rows.is_empty());
}

#[test]
fn a_piece_about_somebody_is_kept_while_they_are_in_the_turn() {
  let mut theirs = piece("their-matter", "a matter of theirs");

  theirs.owner = Some(5);

  let rows = [theirs, piece("kittens", "the office cat")];
  let turn = Turn {
    speakers: vec![5],
    ..said("good morning")
  };
  let narrowed = narrow(&rows, &turn);

  assert_eq!(slugs(&narrowed.rows), ["their-matter"]);
  assert_eq!(narrowed.kept.person, 1);
  assert!(narrow(&rows, &said("good morning")).rows.is_empty());
}

#[test]
fn the_pieces_just_attached_are_kept_two_at_most_the_latest_first() {
  let rows = ["apple", "banana", "cherry", "damson"].map(|slug| piece(slug, slug));
  let turn = Turn {
    attached: [("apple", 5), ("banana", 1), ("cherry", 3)]
      .map(|(slug, ago_minutes)| (slug.to_owned(), NOW - ago_minutes * 60_000))
      .into(),
    ..said("good morning")
  };
  let narrowed = narrow(&rows, &turn);

  assert_eq!(slugs(&narrowed.rows), ["banana", "cherry"]);
  assert_eq!(narrowed.kept.recent, 2);
}

#[test]
fn a_gate_is_asked_about_no_more_than_its_cap_the_closer_matches_first() {
  let mut rows: Vec<Fragment> = (0..GATE_CAP + 4)
    .map(|at| piece(&format!("piece-{at}"), &format!("lantern{at}")))
    .collect();

  rows.push(piece("wanted", "lantern plus kettle"));

  let words: Vec<String> = (0..GATE_CAP + 4).map(|at| format!("lantern{at}")).collect();
  let narrowed = narrow(&rows, &said(&format!("{} lantern kettle", words.join(" "))));

  assert_eq!(narrowed.rows.len(), GATE_CAP);
  assert_eq!(narrowed.capped, 5);
  assert_eq!(narrowed.rows.last().map(|row| row.slug.as_str()), Some("wanted"));
}

#[test]
fn over_the_bots_own_lines_alone_only_an_item_keeps_a_piece() {
  let mut tied = piece("tied", "the deploy notes");

  tied.items = vec![758];

  let rows = [tied, piece("deploy-notes", "how a deploy goes")];
  let turn = Turn {
    rules: Some(vec![KeptBy::Item]),
    ..said("the deploy of #758")
  };

  assert_eq!(slugs(&narrow(&rows, &turn).rows), ["tied"]);
}

#[test]
fn a_line_is_read_without_its_head() {
  assert_eq!(spoken("Owner (id 5): how do deploys go?"), "how do deploys go?");
  assert_eq!(spoken("quiet instruction from the bot: mind the window"), "mind the window");
  assert_eq!(spoken("\u{2026}the end of an answer"), "\u{2026}the end of an answer");
}
