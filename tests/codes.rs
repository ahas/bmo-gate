//! The gate's codes: each spelled in both wire families and read back, and `docs/codes.md` naming the very
//! codes the crate holds, no more and no fewer.

use std::collections::BTreeSet;

use gate_codes::Code;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

#[test]
fn every_code_reads_back_from_either_spelling() {
  for code in Code::ALL {
    assert_eq!(Code::named(code.as_str()), Some(code));
    assert_eq!(Code::named(&code.kebab()), Some(code));
    assert!((400..600).contains(&code.status()), "{code:?} goes out under {}", code.status());
  }
  assert_eq!(Code::named("no_such_code"), None);
}

/// The code in the first cell of every body row of every table in the document.
fn documented_codes() -> BTreeSet<String> {
  let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/docs/codes.md")).unwrap();
  let mut codes = BTreeSet::new();
  let (mut in_head, mut cell, mut first) = (false, 0usize, None::<String>);

  for event in Parser::new_ext(&text, Options::ENABLE_TABLES) {
    match event {
      Event::Start(Tag::TableHead) => in_head = true,
      Event::End(TagEnd::TableHead) => in_head = false,
      Event::Start(Tag::TableRow) => {
        cell = 0;
        first = None;
      }
      Event::Code(code) if !in_head && cell == 0 => first = Some(code.to_string()),
      Event::End(TagEnd::TableCell) => cell += 1,
      Event::End(TagEnd::TableRow) => codes.extend(first.take()),
      _ => {}
    }
  }
  codes
}

#[test]
fn the_codes_document_names_every_code_and_no_other() {
  let held: BTreeSet<String> = Code::ALL.iter().map(|code| code.as_str().to_owned()).collect();

  assert_eq!(documented_codes(), held);
}
