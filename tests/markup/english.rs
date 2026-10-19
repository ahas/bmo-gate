//! The English test: the words its caller sets aside are read past, and Hangul is weighed against Latin letters
//! in the prose alone. The Hangul below is written by its escapes.

use gate_markup::english::EnglishTest;

#[test]
fn a_set_aside_word_is_read_past_and_hangul_is_weighed_against_latin_letters() {
  // A Korean name of three syllables, set aside as the caller's settings would name it.
  let name = "\u{d64d}\u{ae38}\u{b3d9}".to_owned();
  let test = EnglishTest::new(std::slice::from_ref(&name), 4);

  assert!(test.passes(&format!("{name} asked for the report to be read again")));
  assert!(!EnglishTest::new(&[], 0).passes(&format!("{name} asked")));
  assert!(!test.passes("\u{c548}\u{b155}\u{d558}\u{c138}\u{c694} hi"));
  assert!(!test.passes(""));
  assert!(EnglishTest::new(&[], 0).passes("plain words"));
}

#[test]
fn code_and_links_are_read_past_in_a_markdown_text() {
  let test = EnglishTest::new(&[], 4);
  let korean = "\u{d55c}\u{ae00}".repeat(10);

  assert!(test.written(&format!("The build passed.\n\n```\n{korean}\n```\n")));
  assert!(test.written(&format!("See `{korean}` and [{korean}](https://example.com) for it.")));
  assert!(!test.written(&format!("{korean} ok")));
}
