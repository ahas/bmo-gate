//! A text read for whether it is written in English, by the test its caller declares: the words it reads past
//! and how many Latin letters a Hangul syllable is weighed against. The words read past are the caller's own,
//! from its settings, since they are names of people and agents no tracked file holds.

use regex::Regex;

use crate::text::prose;

/// The test of whether a text is written in English: the set-aside words read past, and the Hangul syllables
/// left read against the Latin letters left.
pub struct EnglishTest {
  set_aside: Option<Regex>,
  latin_per_hangul: usize,
}

impl EnglishTest {
  /// A test reading past each of `set_aside`, matched as written, and weighing a Hangul syllable against
  /// `latin_per_hangul` Latin letters; with none, any Hangul left fails it.
  pub fn new(set_aside: &[String], latin_per_hangul: usize) -> Self {
    let mut words: Vec<&str> =
      set_aside.iter().map(String::as_str).filter(|word| !word.is_empty()).collect();

    // The longest first, so a word another one opens is read past whole.
    words.sort_by_key(|word| std::cmp::Reverse(word.len()));

    let set_aside = (!words.is_empty()).then(|| {
      let alternatives: Vec<String> = words.into_iter().map(regex::escape).collect();

      Regex::new(&alternatives.join("|")).expect("escaped words make a pattern")
    });

    Self {
      set_aside,
      latin_per_hangul,
    }
  }

  /// Whether a text is English: with no Latin letters per Hangul syllable, none left at all; otherwise some
  /// Latin letters, and fewer Hangul syllables than one to every so many of them.
  pub fn passes(&self, text: &str) -> bool {
    let prose = match &self.set_aside {
      Some(set_aside) => set_aside.replace_all(text, ""),
      None => text.into(),
    };
    let hangul = prose.chars().filter(|character| ('\u{AC00}'..='\u{D7A3}').contains(character)).count();

    if self.latin_per_hangul == 0 {
      return hangul == 0;
    }

    let latin = prose.chars().filter(char::is_ascii_alphabetic).count();

    latin > 0 && hangul * self.latin_per_hangul < latin
  }

  /// Whether a markdown text's prose is English, its code and its links read past.
  pub fn written(&self, text: &str) -> bool {
    self.passes(&prose(text))
  }
}
