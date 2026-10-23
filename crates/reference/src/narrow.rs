//! What the code keeps of a library before any gate is asked about it (`docs/reference-selection.md`, 「What the
//! code narrows before a gate is asked」): the pieces a turn's text, its speakers and the rows' own columns say
//! it can be about, by the first of five rules each meets — an item the text names, a keyword it carries, a
//! content word of the piece's own it carries, a person in the turn on a piece still current, or a piece the brain
//! handed out a moment ago — and no more than a gate's cap of them. A writer about to write is handed whole the
//! rows a batch names by an item or a word, as many as its cap allows.

use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::{TimeZone, Utc};
use gate_markup::js;
use regex::Regex;

use crate::fragments::{Fragment, Kept};

// How long a finished matter is still a speaker's own business, in days.
const RECENT_DAYS: i64 = 3;

// How long after the brain handed a piece out a turn is still taken to be on it, in milliseconds; and how many
// pieces a gate is asked about for that alone.
const HANDED_OUT_MS: i64 = 30 * 60 * 1000;
const HANDED_OUT_KEPT: usize = 2;

/// The most candidates a gate is asked about on one turn.
pub const GATE_CAP: usize = 12;

// A word standing in more than one row in this many of a gate's rows, and in `COMMON_ROWS` at least, names what the
// library is about rather than what one piece is.
const COMMON_SHARE: usize = 8;
const COMMON_ROWS: usize = 3;

// The words of English that say nothing of what a piece is about.
const COMMON_LATIN: &[&str] = &[
  "about", "after", "again", "all", "also", "and", "any", "are", "because", "been", "before", "being",
  "between", "both", "but", "can", "could", "did", "does", "doing", "down", "during", "each", "every",
  "few", "for", "from", "further", "get", "got", "had", "has", "have", "having", "her", "here", "hers",
  "him", "his", "how", "into", "its", "itself", "just", "let", "more", "most", "must", "nor", "not", "now",
  "off", "once", "one", "only", "other", "our", "ours", "out", "over", "own", "same", "she", "should",
  "some", "such", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "those", "through", "too", "under", "until", "very", "was", "were", "what", "when", "where", "which",
  "while", "who", "whom", "why", "will", "with", "would", "you", "your",
];

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

fn is_syllable(character: char) -> bool {
  ('\u{ac00}'..='\u{d7a3}').contains(&character)
}

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

/// Which rule kept a candidate, in the order they are tried, which is the order a gate's cap keeps them in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum KeptBy {
  Item,
  Keyword,
  Word,
  Person,
  Recent,
}

impl KeptBy {
  pub fn word(self) -> &'static str {
    match self {
      Self::Item => "item",
      Self::Keyword => "keyword",
      Self::Word => "word",
      Self::Person => "person",
      Self::Recent => "recent",
    }
  }
}

/// A content word as the narrowing matches it: a Latin one as the start of a word of the text, one of a script that
/// joins its particles to the word as it stands in the text.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Word {
  Latin(String),
  Joined(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Script {
  Latin,
  Hangul,
  Joined,
  Apart,
}

fn script(character: char) -> Script {
  if character.is_ascii_alphanumeric() {
    Script::Latin
  } else if is_syllable(character) {
    Script::Hangul
  } else if character.is_alphabetic() {
    Script::Joined
  } else {
    Script::Apart
  }
}

// A text cut into runs of one script, lowercased, with what each run is written in.
fn runs(text: &str) -> Vec<(Script, Vec<char>)> {
  let mut found: Vec<(Script, Vec<char>)> = vec![];

  for character in text.chars().flat_map(char::to_lowercase) {
    let of = script(character);

    match found.last_mut() {
      Some((last, run)) if *last == of && of != Script::Apart => run.push(character),
      _ => found.push((of, vec![character])),
    }
  }

  found.retain(|(of, _)| *of != Script::Apart);
  found
}

/// The content words of a text: a Latin word of three letters or more that is not one of English's common words; a
/// Korean word of two syllables or more, one of three or more without its last, where its particle or ending joins
/// it; a word of any other script of two letters or more.
pub fn content_words(text: &str) -> HashSet<Word> {
  runs(text)
    .into_iter()
    .filter_map(|(of, run)| match of {
      Script::Latin => {
        let word = js::text(&run);

        (run.len() >= 3
          && run.iter().any(char::is_ascii_alphabetic)
          && !COMMON_LATIN.contains(&word.as_str()))
        .then_some(Word::Latin(word))
      }
      Script::Hangul if run.len() >= 3 => Some(Word::Joined(js::text(&run[..run.len() - 1]))),
      Script::Hangul | Script::Joined => (run.len() >= 2).then(|| Word::Joined(js::text(&run))),
      Script::Apart => None,
    })
    .collect()
}

/// A text as the word rule reads it: its Latin words, and the whole of it lowercased.
pub struct Said {
  latin: Vec<String>,
  lower: String,
}

impl Said {
  pub fn of(text: &str) -> Self {
    Self {
      latin: runs(text)
        .into_iter()
        .filter(|(of, _)| *of == Script::Latin)
        .map(|(_, run)| js::text(&run))
        .collect(),
      lower: text.to_lowercase(),
    }
  }

  /// Whether a content word stands in the text.
  pub fn carries(&self, word: &Word) -> bool {
    match word {
      Word::Latin(word) => self.latin.iter().any(|said| said.starts_with(word.as_str())),
      Word::Joined(word) => self.lower.contains(word.as_str()),
    }
  }
}

/// A row's own content words: its slug's, its title's and its body's where it carries one.
pub fn row_words(row: &Fragment) -> HashSet<Word> {
  let mut words = content_words(&row.slug.replace('-', " "));

  words.extend(content_words(&row.title));

  if let Some(body) = &row.body {
    words.extend(content_words(body));
  }

  words
}

// The words that stand in so many of these rows that they say what the rows are about together.
fn common_words(of_rows: &[HashSet<Word>]) -> HashSet<Word> {
  let mut counted: std::collections::HashMap<&Word, usize> = std::collections::HashMap::new();

  for words in of_rows {
    for word in words {
      *counted.entry(word).or_default() += 1;
    }
  }

  let floor = COMMON_ROWS.max(of_rows.len() / COMMON_SHARE + 1);

  counted
    .into_iter()
    .filter(|(_, rows)| *rows >= floor)
    .map(|(word, _)| word.clone())
    .collect()
}

/// A turn as the narrowing reads it: its text, what its messages and the message it follows on from said with their
/// heads left off, who spoke, the names the receiver knows each person by, the earliest confirmed day a finished
/// piece may carry and still count, the moment it is read at in epoch milliseconds, and the rules that may keep a
/// row where fewer than all of them may.
pub struct Turn {
  pub text: String,
  pub said: String,
  pub speakers: Vec<i64>,
  pub names: std::collections::HashMap<i64, Vec<String>>,
  pub recent_since: Option<String>,
  pub now: i64,
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
/// rule, the recent rule keeping the latest handed out alone, and no more than the gate's cap of them.
pub fn narrow(rows: &[Fragment], turn: &Turn) -> Narrowed {
  let asked: HashSet<i64> = items_asked(&turn.text).into_iter().collect();
  let present: HashSet<i64> = turn.speakers.iter().copied().chain(named_people(rows, turn)).collect();
  let allowed = |by: KeptBy| turn.rules.as_ref().is_none_or(|rules| rules.contains(&by));
  let words: Vec<HashSet<Word>> = rows.iter().map(row_words).collect();
  let common = common_words(&words);
  let said = Said::of(&turn.said);
  // Each row a rule keeps: where it stands, the rule, and how many of its words the turn carries.
  let mut found: Vec<(usize, KeptBy, usize)> = vec![];
  let mut handed_out: Vec<(usize, i64)> = vec![];

  for (at, row) in rows.iter().enumerate() {
    let items = row.items.iter().filter(|item| asked.contains(item)).count();
    let keywords = words_carried(&row.keywords, &turn.text);
    let shared = words[at].iter().filter(|word| !common.contains(*word) && said.carries(word)).count();
    let current = row.status == "open"
      || matches!((&turn.recent_since, &row.confirmed_on), (Some(since), Some(on)) if on >= since);
    let person = current && row.owner.is_some_and(|owner| present.contains(&owner));
    let kept = [
      (KeptBy::Item, items > 0),
      (KeptBy::Keyword, keywords > 0),
      (KeptBy::Word, shared > 0),
      (KeptBy::Person, person),
    ]
    .into_iter()
    .find(|(by, meets)| *meets && allowed(*by));

    match (kept, row.last_hit_at) {
      (Some((by, _)), _) => found.push((at, by, shared)),
      (None, Some(hit))
        if allowed(KeptBy::Recent) && hit <= turn.now && turn.now - hit <= HANDED_OUT_MS =>
      {
        handed_out.push((at, hit));
      }
      _ => {}
    }
  }

  handed_out.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
  found.extend(handed_out.into_iter().take(HANDED_OUT_KEPT).map(|(at, _)| (at, KeptBy::Recent, 0)));

  found.sort_by(|left, right| left.1.cmp(&right.1).then(right.2.cmp(&left.2)).then(left.0.cmp(&right.0)));

  let capped = found.len().saturating_sub(GATE_CAP) as i64;

  found.truncate(GATE_CAP);
  found.sort_by_key(|(at, ..)| *at);

  let mut kept = Kept::default();

  for (_, by, _) in &found {
    match by {
      KeptBy::Item => kept.item += 1,
      KeptBy::Keyword => kept.keyword += 1,
      KeptBy::Word => kept.word += 1,
      KeptBy::Person => kept.person += 1,
      KeptBy::Recent => kept.recent += 1,
    }
  }

  Narrowed {
    rows: found.iter().map(|(at, ..)| rows[*at].clone()).collect(),
    held: rows.len() as i64,
    kept,
    capped,
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
