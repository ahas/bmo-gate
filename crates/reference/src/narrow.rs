//! What the code keeps of a library before any gate is asked about it (`docs/reference-selection.md`, 「What the
//! code narrows before a gate is asked」): the pieces a turn's text, its speakers and the rows' own columns say
//! it can be about, by the first of three rules each meets — an item the text names, a keyword it carries, or
//! a person in the turn on a piece still current. Nothing caps how many a gate keeps; a writer about to write is
//! handed whole the rows a batch names by an item or a word, as many as its cap allows.

use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::{TimeZone, Utc};
use gate_markup::js;
use regex::Regex;

use crate::fragments::{Fragment, Kept};

// How long a finished matter is still a speaker's own business, in days.
const RECENT_DAYS: i64 = 3;

// The ending a person's address piece carries, whose keywords are the names they are called by.
const ADDRESS_TOPIC: &str = "-address";

// The word that follows an item's number when a person names it, and the two that make the number something
// else; and the word that opens an item named as one.
const ITEM_WORD: char = '\u{bc88}';
const NOT_ITEM: [char; 2] = ['\u{d638}', '\u{c9f8}'];

static WRITTEN_ITEM: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"#([0-9]{1,5})(?-u:\b)").expect("an item's mark"));
static NAMED_ITEM: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(&format!("\u{d56d}\u{baa9}[{}]*#?([0-9]{{1,5}})", js::SPACE)).expect("an item named as one")
});
static HANGUL: LazyLock<Regex> = LazyLock::new(|| Regex::new("[\u{ac00}-\u{d7a3}]").expect("a syllable"));

/// The day `RECENT_DAYS` before a moment in milliseconds, in Korean time, as a piece's confirmed day is written.
pub fn recent_since_of(now_ms: i64) -> String {
  let at = now_ms - RECENT_DAYS * 86_400_000 + 9 * 3_600_000;

  Utc
    .timestamp_millis_opt(at)
    .single()
    .map_or_else(String::new, |moment| moment.format("%Y-%m-%d").to_string())
}

fn unique<T: Clone + Eq + std::hash::Hash>(values: impl IntoIterator<Item = T>) -> Vec<T> {
  let mut seen = HashSet::new();

  values.into_iter().filter(|value| seen.insert(value.clone())).collect()
}

// The items a text names by a number and the word that follows it: a run of two to five digits standing on
// its own, then that word, not opening a word that makes the number something else.
fn items_by_word(text: &str) -> Vec<i64> {
  let characters = js::chars(text);
  let mut found = vec![];

  for start in 0..characters.len() {
    if start > 0 && characters[start - 1].is_ascii_digit() {
      continue;
    }

    let digits = characters[start..].iter().take_while(|character| character.is_ascii_digit()).count();

    if !(2..=5).contains(&digits) {
      continue;
    }

    let mut at = start + digits;

    while at < characters.len() && js::is_space(characters[at]) {
      at += 1;
    }

    if characters.get(at) == Some(&ITEM_WORD)
      && !characters.get(at + 1).is_some_and(|next| NOT_ITEM.contains(next))
    {
      found.push(js::text(&characters[start..start + digits]).parse().unwrap_or_default());
    }
  }

  found
}

/// The items a text names: by their mark, by a number and the word for one, or named as one.
pub fn items_asked(text: &str) -> Vec<i64> {
  let marked = WRITTEN_ITEM.captures_iter(text).filter_map(|found| found[1].parse().ok());
  let named = NAMED_ITEM.captures_iter(text).filter_map(|found| found[1].parse().ok());

  unique(unique(marked).into_iter().chain(items_by_word(text)).chain(named))
}

/// How many of these words a text carries: one with Korean in it where it stands, any other whole.
pub fn words_carried(words: &[String], text: &str) -> usize {
  let lower = text.to_lowercase();
  let words = unique(
    words
      .iter()
      .map(|word| js::trim(word).to_lowercase())
      .filter(|word| js::units(word) >= 2),
  );

  words
    .iter()
    .filter(|word| {
      if HANGUL.is_match(word) {
        return lower.contains(word.as_str());
      }

      Regex::new(&format!("(?:^|[^a-z0-9]){}(?:[^a-z0-9]|$)", regex::escape(word)))
        .is_ok_and(|whole| whole.is_match(&lower))
    })
    .count()
}

// Whether a number stands in a text with no digit either side of it.
fn names_number(text: &str, number: i64) -> bool {
  let wanted = number.to_string();

  text.match_indices(&wanted).any(|(at, _)| {
    let before = text[..at].chars().next_back();
    let after = text[at + wanted.len()..].chars().next();

    !before.is_some_and(|one| one.is_ascii_digit()) && !after.is_some_and(|one| one.is_ascii_digit())
  })
}

/// Which rule kept a candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeptBy {
  Item,
  Keyword,
  Person,
}

impl KeptBy {
  pub fn word(self) -> &'static str {
    match self {
      Self::Item => "item",
      Self::Keyword => "keyword",
      Self::Person => "person",
    }
  }
}

/// A turn as the narrowing reads it: its text, who spoke, the names the receiver knows each person by, the
/// earliest confirmed day a finished piece may carry and still count, and the rules that may keep a row where
/// fewer than all of them may.
pub struct Turn {
  pub text: String,
  pub speakers: Vec<i64>,
  pub names: std::collections::HashMap<i64, Vec<String>>,
  pub recent_since: Option<String>,
  pub rules: Option<Vec<KeptBy>>,
}

/// What the narrowing kept, and how it came to.
pub struct Narrowed {
  pub rows: Vec<Fragment>,
  pub held: i64,
  pub kept: Kept,
  pub capped: i64,
}

// The people a turn names: by their number, by the name the receiver knows, or by a name their address piece
// carries.
fn named_people(rows: &[Fragment], turn: &Turn) -> HashSet<i64> {
  let owners: HashSet<i64> = rows.iter().filter_map(|row| row.owner).collect();

  owners
    .into_iter()
    .filter(|owner| {
      let addressed = rows
        .iter()
        .filter(|row| row.owner == Some(*owner) && row.slug.ends_with(ADDRESS_TOPIC))
        .flat_map(|row| row.keywords.iter().cloned());
      let names: Vec<String> = turn
        .names
        .get(owner)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .chain(addressed)
        .collect();

      names_number(&turn.text, *owner) || words_carried(&names, &turn.text) > 0
    })
    .collect()
}

/// The rows a gate is asked about, in the order they came in: every one a rule keeps, where the turn allows that
/// rule.
pub fn narrow(rows: &[Fragment], turn: &Turn) -> Narrowed {
  let asked: HashSet<i64> = items_asked(&turn.text).into_iter().collect();
  let present: HashSet<i64> = turn.speakers.iter().copied().chain(named_people(rows, turn)).collect();
  let mut kept = Kept::default();
  let mut chosen = vec![];

  for row in rows {
    let items = row.items.iter().filter(|item| asked.contains(item)).count();
    let words = words_carried(&row.keywords, &turn.text);
    let current = row.status == "open"
      || matches!((&turn.recent_since, &row.confirmed_on), (Some(since), Some(on)) if on >= since);
    let person = current && row.owner.is_none_or(|owner| present.contains(&owner));
    let by = if items > 0 {
      KeptBy::Item
    } else if words > 0 {
      KeptBy::Keyword
    } else if person {
      KeptBy::Person
    } else {
      continue;
    };

    if turn.rules.as_ref().is_some_and(|rules| !rules.contains(&by)) {
      continue;
    }

    match by {
      KeptBy::Item => kept.item += 1,
      KeptBy::Keyword => kept.keyword += 1,
      KeptBy::Person => kept.person += 1,
    }

    chosen.push(row.clone());
  }

  Narrowed {
    rows: chosen,
    held: rows.len() as i64,
    kept,
    capped: 0,
  }
}

/// How many pieces a writer is handed whole on the strength of the batch's own words, beside the ones it is
/// always handed.
pub const WRITER_MATCH_CAP: usize = 24;

/// The rows a writer is handed whole before it writes (the brain's `docs/fragments.md`, 「Finding a piece before
/// writing one」):
/// every row the caller always hands over, and the rows the batch's text names by an item or a keyword — never a
/// row kept only for its person. Where more are named than the cap, the item matches go first, then the rows
/// carrying more of the text's words, then the ones whose person is in the batch, then the latest confirmed,
/// then the order they came in. They come back in the order the rows were given.
pub fn rows_to_hand(rows: &[Fragment], batch: &Turn, always: impl Fn(&Fragment) -> bool) -> Vec<Fragment> {
  let asked: HashSet<i64> = items_asked(&batch.text).into_iter().collect();
  // The rows named by an item or a word, by where they stand among the rows given.
  let named: Vec<usize> = (0..rows.len())
    .filter(|&at| !always(&rows[at]))
    .filter(|&at| {
      let row = &rows[at];

      row.items.iter().any(|item| asked.contains(item)) || words_carried(&row.keywords, &batch.text) > 0
    })
    .collect();
  let owned: Vec<Fragment> = named.iter().map(|&at| rows[at].clone()).collect();
  let present: HashSet<i64> = batch.speakers.iter().copied().chain(named_people(&owned, batch)).collect();
  let mut scored: Vec<(usize, usize, bool, &str, usize)> = named
    .iter()
    .map(|&at| {
      let row = &rows[at];
      let items = row.items.iter().filter(|item| asked.contains(item)).count();
      let words = words_carried(&row.keywords, &batch.text);
      let current = row.status == "open"
        || matches!((&batch.recent_since, &row.confirmed_on), (Some(since), Some(on)) if on >= since);
      let person = current && row.owner.is_none_or(|owner| present.contains(&owner));

      (items, words, person, row.confirmed_on.as_deref().unwrap_or_default(), at)
    })
    .collect();

  if scored.len() > WRITER_MATCH_CAP {
    scored.sort_by(|left, right| {
      right
        .0
        .cmp(&left.0)
        .then(right.1.cmp(&left.1))
        .then(right.2.cmp(&left.2))
        .then(right.3.cmp(left.3))
        .then(left.4.cmp(&right.4))
    });
    scored.truncate(WRITER_MATCH_CAP);
  }

  let kept: HashSet<usize> = scored.iter().map(|(.., at)| *at).collect();

  rows
    .iter()
    .enumerate()
    .filter(|(at, row)| always(row) || kept.contains(at))
    .map(|(_, row)| row.clone())
    .collect()
}
