//! The viewer's reading of a markdown text: its headings outside fences, its halves, its sections, which of its
//! parts are Korean, and which stand in a language another script writes. Hangul is written by its escapes; kana and
//! Han characters are counted out of their blocks.

use gate_stages::markdown::{
  Scripts, halve_text, heading_shape, is_korean, korean_parts, sections, translation_parts,
};

// So many characters of a Unicode block, counted out from its start.
fn counted(from: u32, many: u32) -> String {
  (0..many).map(|at| char::from_u32(from + at).unwrap()).collect()
}

fn scripts(names: &[&str]) -> Scripts {
  Scripts::of(&names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>()).unwrap()
}

#[test]
fn a_text_stands_in_a_languages_scripts_where_they_outweigh_its_other_letters() {
  let japanese = scripts(&["Hiragana", "Katakana", "Han"]);
  let chinese = scripts(&["Han"]);
  let kana_and_han = format!("{}{} React {}", counted(0x3042, 6), counted(0x4e00, 4), counted(0x30a2, 3));
  let han = format!("{} React {}", counted(0x4e00, 3), counted(0x4e10, 2));

  assert!(japanese.hold(&kana_and_han), "kana and Han with an English word are Japanese");
  assert!(!chinese.hold(&kana_and_han), "a text of more kana than Han is no Chinese");
  assert!(chinese.hold(&han), "Han characters with an English word are Chinese");
  assert!(japanese.hold(&han), "Han characters alone stand in Japanese as well");
  assert!(!japanese.hold("The build finished and the release is live."));
  assert!(!chinese.hold(&counted(0xac00, 8)), "Hangul is no Chinese");
  assert!(
    chinese.hold("`some code` 42"),
    "a text with no letters outside code stands in any language"
  );
}

#[test]
fn a_part_with_no_letters_stands_as_the_whole_text_does_and_a_blank_part_is_none() {
  let chinese = scripts(&["Han"]);
  let text = "An English line.\n\n```\nlet x = 1;\n```\n\n   \n";
  let parts = vec![
    "An English line.\n\n".to_owned(),
    "```\nlet x = 1;\n```\n\n".to_owned(),
    "   \n".to_owned(),
  ];

  assert_eq!(chinese.foreign_parts(text, &parts), vec![true, true, false]);
}

#[test]
fn a_script_list_naming_no_script_is_none() {
  assert!(Scripts::of(&[]).is_none());
  assert!(Scripts::of(&["Han}]".to_owned()]).is_none());
  assert!(Scripts::of(&["Nowhere".to_owned()]).is_none());
}

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
