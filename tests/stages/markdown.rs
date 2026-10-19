//! The viewer's reading of a markdown text: its headings outside fences, its halves, its sections, and which of its
//! parts are Korean. Hangul is written by its escapes.

use gate_stages::markdown::{
  halve_text, heading_shape, is_korean, korean_parts, sections, translation_parts,
};

#[test]
fn only_atx_headings_outside_fences_count() {
  let text = "intro\n# One\n```\n# not one\n```\n## Two\nSetext\n===\n#\n";

  assert_eq!(heading_shape(text), "1:1,2:1");
  assert_eq!(sections(text).concat(), text);
}

#[test]
fn a_text_halves_at_the_paragraph_nearest_its_middle() {
  let ([first, second], joint) = halve_text("aaaa\n\nbbbb\ncccc").unwrap();

  assert_eq!((first.as_str(), second.as_str(), joint), ("aaaa\n\n", "bbbb\ncccc", "\n\n"));
  assert!(halve_text("one line").is_none());
}

#[test]
fn a_text_is_korean_unless_its_latin_letters_outnumber_its_syllables_fourfold() {
  assert!(is_korean("\u{C791}\u{C5C5}\u{C744} \u{B05D}\u{B0C8}\u{C5B4}\u{C694}"));
  assert!(!is_korean("check the log and the docs"));
  assert!(!is_korean(
    "check the log\n```\n\u{D55C}\u{AE00}\u{D55C}\u{AE00}\u{D55C}\u{AE00}\u{D55C}\u{AE00}\n```"
  ));
}

// A text holding a long fenced quote, cut so the quote stands as a part of its own.
fn quoting(before: &str, after: &str) -> (String, Vec<String>, usize) {
  let quote = format!("```text\n{}\n```\n\n", "\u{D55C}\u{AE00}".repeat(30));
  let text = format!("{before}\n\n{quote}{after}");
  let parts = translation_parts(&text, 40);
  let alone = parts
    .iter()
    .position(|part| part.trim() == quote.trim())
    .unwrap_or_else(|| panic!("the quote cut into a part of its own: {parts:?}"));

  (text, parts, alone)
}

#[test]
fn a_fenced_quote_cut_alone_in_an_english_text_is_english() {
  let (text, parts, alone) = quoting("Read the quote below and do what it asks.", "Then report back.");

  assert_eq!(korean_parts(&text, &parts), vec![false; parts.len()]);
  assert!(is_korean(&parts[alone]));
}

#[test]
fn a_fenced_quote_cut_alone_in_a_korean_text_is_korean() {
  let words = "\u{C791}\u{C5C5}\u{C744} \u{B05D}\u{B0C8}\u{C5B4}\u{C694}.";
  let (text, parts, alone) = quoting(words, words);

  assert_eq!(korean_parts(&text, &parts), vec![true; parts.len()]);
  assert!(korean_parts(&text, &parts)[alone]);
}

#[test]
fn a_blank_part_is_never_korean() {
  assert_eq!(korean_parts("", &[String::new(), "\n\n".to_owned()]), vec![false, false]);
}
