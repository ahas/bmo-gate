//! Small readings of a text the gate's records and reports share: a count grouped by thousands, the months a
//! piece's days span, a markdown text's fenced code blocks and its prose, and the mark a text not translated yet
//! stands under. Markdown is read here as CommonMark reads it.

use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};

/// The line a text that is not translated yet stands under.
pub const UNTRANSLATED_MARK: &str = "[Not translated: this stands in its original Korean.]";

/// A count with its thousands grouped by commas.
pub fn count_text(value: usize) -> String {
  let digits = value.to_string();
  let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);

  for (at, digit) in digits.chars().enumerate() {
    if at > 0 && (digits.len() - at).is_multiple_of(3) {
      grouped.push(',');
    }

    grouped.push(digit);
  }

  grouped
}

/// The months a piece's days span, as an index line shows them: one `YYYY-MM`, or `from~to`.
pub fn period_of(written_on: Option<&str>, confirmed_on: Option<&str>) -> Option<String> {
  let from = written_on.or(confirmed_on)?.get(..7)?;
  let to = confirmed_on.or(written_on)?.get(..7)?;

  Some(if from == to { from.to_owned() } else { format!("{from}~{to}") })
}

/// The fenced code blocks of a markdown text in order, each whole from its opening fence to its closing one.
pub fn fenced_blocks(text: &str) -> Vec<String> {
  Parser::new(text)
    .into_offset_iter()
    .filter_map(|(event, range)| match event {
      Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(_))) => {
        Some(text[range].trim_end_matches(['\n', '\r']).to_owned())
      }
      _ => None,
    })
    .collect()
}

/// A markdown text's prose: its text as read, with its code blocks, its code spans and its links read past,
/// and a line break where a block or a break stood.
pub fn prose(text: &str) -> String {
  let mut out = String::new();
  let mut code = 0usize;
  let mut link = 0usize;

  for event in Parser::new(text) {
    match event {
      Event::Start(Tag::CodeBlock(_)) => code += 1,
      Event::End(TagEnd::CodeBlock) => {
        code = code.saturating_sub(1);
        out.push('\n');
      }
      Event::Start(Tag::Link { .. } | Tag::Image { .. }) => link += 1,
      Event::End(TagEnd::Link | TagEnd::Image) => link = link.saturating_sub(1),
      Event::Text(words) if code == 0 && link == 0 => out.push_str(&words),
      Event::SoftBreak | Event::HardBreak => out.push('\n'),
      Event::End(TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::Item) => out.push('\n'),
      _ => {}
    }
  }

  out
}
