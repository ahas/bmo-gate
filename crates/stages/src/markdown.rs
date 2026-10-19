//! The structure of a markdown text as the documents viewer reads it: its ATX headings, its paragraphs and inline
//! code, where it may be cut, its sections, and the parts the translator is given. The web unit's document viewer
//! cuts and counts by the same reading, and a translation is told to have kept its structure by it, so the reading
//! has to be the viewer's line for line rather than a CommonMark one: only a line of one to six `#` is a heading, a
//! setext underline is text, a line inside a fenced block is code and nothing is cut inside one. No maintained
//! markdown library reads a text that way, which is why the reading is written here.

use std::sync::LazyLock;

use regex::Regex;

static ATX: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$").expect("a heading"));
static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})").expect("a fence"));
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").expect("a link"));
static TICKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`+").expect("code marks"));
static STRONG: LazyLock<[Regex; 3]> = LazyLock::new(|| {
  [r"\*\*(.+?)\*\*", r"__(.+?)__", r"~~(.+?)~~"].map(|pattern| Regex::new(pattern).expect("an emphasis"))
});
static HANGUL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x{AC00}-\x{D7A3}]").expect("a syllable"));
static LATIN: LazyLock<Regex> = LazyLock::new(|| Regex::new("[A-Za-z]").expect("a letter"));
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]*`").expect("inline code"));
static CODE_SPAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]+`").expect("a code span"));

/// How much of a text one translation part carries, in estimated tokens.
pub const TRANSLATION_PART_TOKENS: usize = 750;

// Whether a heading's words come to anything once the markup around them falls away: a link or an image
// standing as its words, code marks and strong emphasis gone. What remains after the rest of the viewer's
// stripping is never empty where this is not.
fn has_words(text: &str) -> bool {
  let plain = LINK.replace_all(text, "$1");
  let plain = TICKS.replace_all(&plain, "");
  let plain = STRONG
    .iter()
    .fold(plain.into_owned(), |kept, pattern| pattern.replace_all(&kept, "$1").into_owned());

  !plain.trim().is_empty()
}

// The fence a line opens or closes a block with, as far as the line alone can say.
fn fence_of(line: &str) -> Option<&str> {
  FENCE.captures(line).and_then(|found| found.get(1)).map(|fence| fence.as_str())
}

// Whether a line closes the block a fence opened.
fn closes(line: &str, fence: &str) -> bool {
  fence_of(line).is_some_and(|marker| {
    marker.as_bytes()[0] == fence.as_bytes()[0] && marker.len() >= fence.len() && line.trim() == marker
  })
}

/// Every heading of a text in its order, as its depth and the line it stands on, counted from 1; a heading
/// with no words is none.
pub fn headings(source: &str) -> Vec<(usize, usize)> {
  let normal = source.replace("\r\n", "\n").replace('\r', "\n");
  let mut found = vec![];
  let mut fence: Option<String> = None;

  for (index, line) in normal.split('\n').enumerate() {
    if let Some(open) = &fence {
      if closes(line, open) {
        fence = None;
      }

      continue;
    }

    if let Some(marker) = fence_of(line) {
      fence = Some(marker.to_owned());
      continue;
    }

    let Some(heading) = ATX.captures(line) else { continue };

    if has_words(heading.get(2).map_or("", |words| words.as_str())) {
      found.push((heading[1].len(), index + 1));
    }
  }

  found
}

/// How many headings a text has at each depth, as one string two texts of the same structure share.
pub fn heading_shape(source: &str) -> String {
  let mut counts = [0_usize; 6];

  for (depth, _) in headings(source) {
    counts[depth - 1] += 1;
  }

  counts
    .iter()
    .enumerate()
    .filter(|(_, count)| **count > 0)
    .map(|(depth, count)| format!("{}:{count}", depth + 1))
    .collect::<Vec<_>>()
    .join(",")
}

// Each line of a text with whether it stands in a fenced code block, the fence lines included.
fn fenced_lines(source: &str) -> Vec<(String, bool)> {
  let normal = source.replace("\r\n", "\n").replace('\r', "\n");
  let mut fence: Option<String> = None;

  normal
    .split('\n')
    .map(|line| {
      if let Some(open) = &fence {
        if closes(line, open) {
          fence = None;
        }

        return (line.to_owned(), true);
      }

      fence = fence_of(line).map(str::to_owned);
      (line.to_owned(), fence.is_some())
    })
    .collect()
}

/// How many paragraphs a text has: runs of lines parted by a blank line outside any code block, a fenced block
/// counting with the lines it stands among.
pub fn paragraph_count(source: &str) -> usize {
  let mut count = 0;
  let mut within = false;

  for (line, fenced) in fenced_lines(source) {
    let blank = !fenced && line.trim().is_empty();

    if !blank && !within {
      count += 1;
    }

    within = !blank;
  }

  count
}

/// Every inline code span of a text outside its fenced blocks, marks and all, in order.
pub fn inline_code(source: &str) -> Vec<String> {
  fenced_lines(source)
    .into_iter()
    .filter(|(_, fenced)| !fenced)
    .flat_map(|(line, _)| {
      CODE_SPAN.find_iter(&line).map(|span| span.as_str().to_owned()).collect::<Vec<_>>()
    })
    .collect()
}

// The UTF-16 units of a text, which every offset here counts in, as the viewer's do.
fn units(text: &str) -> Vec<u16> {
  text.encode_utf16().collect()
}

/// A text in two at the paragraph boundary nearest its middle, or the line boundary nearest it where there is
/// none, outside any fenced block, with what joins the halves back; none where it is one line.
pub fn halve_text(text: &str) -> Option<([String; 2], &'static str)> {
  let all = units(text);
  let lines: Vec<&str> = text.split('\n').collect();
  let mut paragraphs = vec![];
  let mut breaks = vec![];
  let mut fence: Option<String> = None;
  let mut offset = 0;

  for (index, line) in lines.iter().enumerate() {
    match &fence {
      Some(open) if closes(line, open) => fence = None,
      Some(_) => {}
      None => fence = fence_of(line).map(str::to_owned),
    }

    offset += line.encode_utf16().count() + 1;

    if fence.is_none() && index < lines.len() - 1 && offset < all.len() {
      breaks.push(offset);

      if line.trim().is_empty() {
        paragraphs.push(offset);
      }
    }
  }

  let points = if paragraphs.is_empty() { &breaks } else { &paragraphs };
  let middle = all.len() as f64 / 2.0;
  let cut = points.iter().copied().reduce(|best, point| {
    if (point as f64 - middle).abs() < (best as f64 - middle).abs() { point } else { best }
  })?;

  Some((
    [String::from_utf16_lossy(&all[..cut]), String::from_utf16_lossy(&all[cut..])],
    if paragraphs.is_empty() { "\n" } else { "\n\n" },
  ))
}

/// A text as its sections: the lines before its first heading, then each heading with the lines under it up
/// to the next heading of any depth. Joined back, the sections are the text.
pub fn sections(source: &str) -> Vec<String> {
  let lines: Vec<&str> = source.split('\n').collect();
  let mut found = vec![];
  let mut from = 0;

  for start in headings(source).into_iter().map(|(_, line)| line - 1).filter(|start| *start > 0) {
    found.push(format!("{}\n", lines[from..start].join("\n")));
    from = start;
  }

  found.push(lines[from..].join("\n"));
  found
}

/// A rough count of the tokens a text costs a model: a character outside ASCII as most of one, an ASCII one
/// as about a third.
pub fn estimated_tokens(text: &str) -> usize {
  let all = units(text);
  let ascii = all.iter().filter(|unit| **unit < 128).count();

  ((all.len() - ascii) as f64 * 0.8 + ascii as f64 * 0.3).ceil() as usize
}

fn fitted(section: String, budget: usize) -> Vec<String> {
  if estimated_tokens(&section) <= budget {
    return vec![section];
  }

  match halve_text(&section) {
    None => vec![section],
    Some(([first, second], _)) => {
      let mut parts = fitted(first, budget);

      parts.extend(fitted(second, budget));
      parts
    }
  }
}

/// A text as the parts the translator is given: its sections, consecutive ones packed together while they
/// fit, one too large alone cut at its paragraphs. Joined back, the parts are the text.
pub fn translation_parts(text: &str, budget: usize) -> Vec<String> {
  let mut parts = vec![];
  let mut current = String::new();

  for piece in sections(text).into_iter().flat_map(|section| fitted(section, budget)) {
    if !current.is_empty() && estimated_tokens(&format!("{current}{piece}")) > budget {
      parts.push(std::mem::take(&mut current));
    }

    current.push_str(&piece);
  }

  if !current.is_empty() || parts.is_empty() {
    parts.push(current);
  }

  parts
}

// The text with its fenced blocks taken out, as a block reads from its opening line to the line that closes
// it with the same fence; a block nothing closes is no block and stays.
fn without_fences(text: &str) -> String {
  let mut kept = vec![];
  let mut open: Option<(String, Vec<&str>)> = None;

  for line in text.split('\n') {
    match &mut open {
      Some((fence, held)) => {
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();

        if indent <= 3 && trimmed.trim_end_matches([' ', '\t']) == fence {
          open = None;
        } else {
          held.push(line);
        }
      }
      None => match fence_of(line) {
        Some(fence) => open = Some((fence.to_owned(), vec![line])),
        None => kept.push(line),
      },
    }
  }

  if let Some((_, held)) = open {
    kept.extend(held);
  }

  kept.join("\n")
}

// A text's letters outside code, as its Hangul syllables and its Latin letters.
fn letters(text: &str) -> (usize, usize) {
  let prose = without_fences(text);
  let prose = INLINE_CODE.replace_all(&prose, "");

  (HANGUL.find_iter(&prose).count(), LATIN.find_iter(&prose).count())
}

/// Whether a text is written in Korean, by its letters outside code: few Hangul syllables against its Latin
/// letters make it English.
pub fn is_korean(text: &str) -> bool {
  let (hangul, latin) = letters(text);

  hangul * 4 >= latin
}

/// Which of a text's parts, as `translation_parts` cut it, are Korean: each by its own letters outside code, and
/// one with none there to count by the whole text's, so a fenced quote cut into a part of its own is read as the
/// text it stands in. A blank part is none.
pub fn korean_parts(text: &str, parts: &[String]) -> Vec<bool> {
  let whole = is_korean(text);

  parts
    .iter()
    .map(|part| match letters(part) {
      _ if part.trim().is_empty() => false,
      (0, 0) => whole,
      (hangul, latin) => hangul * 4 >= latin,
    })
    .collect()
}

/// One part as it stands once read: its translation, ending as the original ended where the original
/// closed its line.
pub fn shown_part(source: &str, text: &str) -> String {
  if source.ends_with('\n') && !text.ends_with('\n') {
    return format!("{text}{}", if source.ends_with("\n\n") { "\n\n" } else { "\n" });
  }

  text.to_owned()
}
