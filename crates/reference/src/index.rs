//! The brain's index as an agent reads it itself (`docs/reference-selection.md`, 「The index an agent reads」):
//! five groups of entries, each entry what it holds and when it is read, the session's loads counted out of the
//! unread, a piece read whole by its slug and recorded among the session's loads, and a search over every
//! entry's words. No model is asked.

use std::collections::HashSet;
use std::sync::LazyLock;

use gate_markup::js::bun_hash;
use gate_ports::PortError;
use gate_ports::brain::{Condition, Load, MemoryRow, Reply};
use regex::Regex;

use crate::fragments::{self, Fragment};
use crate::road::{KNOWLEDGE, LORE, PERSON_BOOK, ROOM_RULE, SYSTEM_DOCUMENT, held_sheet};
use crate::{Reference, memories};

/// The groups, in the order an index stands them in.
pub const GROUPS: [&str; 5] = ["system-documents", "room-rules", "knowledge", "people", "room-memories"];

/// How long ago a change still makes a group's hint, in milliseconds: three days.
const FRESH_MS: i64 = 3 * 24 * 60 * 60 * 1000;

/// The most a search answers, and how many where none is asked.
pub const SEARCH_MOST: usize = 24;
pub const SEARCH_DEFAULT: usize = 8;

/// One entry of a group: its slug, what it holds and when it is read, its path, when it last changed where that is
/// known, and how its whole text is read.
#[derive(Clone, Debug)]
pub struct IndexEntry {
  pub slug: String,
  pub holds: String,
  pub read_when: Option<String>,
  pub path: String,
  pub changed_at: Option<i64>,
  body: Body,
}

#[derive(Clone, Debug)]
enum Body {
  Shipped,
  Knowledge,
  Lore,
  Person(i64),
  Text(String),
}

/// One group as an index answers it.
#[derive(Clone, Debug)]
pub struct Group {
  pub group: &'static str,
  pub unread: usize,
  pub hint: Option<String>,
  pub entries: Vec<IndexEntry>,
}

/// A piece read whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Piece {
  pub slug: String,
  pub group: String,
  pub path: String,
  pub text: String,
}

/// Why an index, a piece or a search was not answered.
#[derive(Debug)]
pub enum Unanswered {
  NoGroup(String),
  NoPiece,
  Unit(PortError),
}

static NEEDED: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(r"(?i);\s*((?:needed|consulted|read|attached|used)\b.*\bwhen\b.*)$").expect("the split reads")
});

/// A title split where it says when it is needed: what stands before is what the entry holds, the rest when it is
/// read; a title that says no such thing is all it holds.
pub fn split_title(title: &str) -> (String, Option<String>) {
  match NEEDED.captures(title) {
    Some(found) => {
      let whole = found.get(0).expect("the match");
      let holds = title[..whole.start()].trim().to_owned();
      let read_when = found.get(1).map(|when| when.as_str().trim().to_owned());

      (holds, read_when)
    }
    None => (title.trim().to_owned(), None),
  }
}

// A day a row writes, `YYYY-MM-DD`, as the epoch milliseconds it began at.
fn day_ms(day: Option<&str>) -> Option<i64> {
  let day = chrono::NaiveDate::parse_from_str(day?.get(..10)?, "%Y-%m-%d").ok()?;

  Some(day.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

fn fragment_entry(row: &Fragment, body: Body) -> IndexEntry {
  let (holds, read_when) = split_title(&row.title);
  let changed_at = day_ms(row.confirmed_on.as_deref()).max(day_ms(row.written_on.as_deref()));

  IndexEntry {
    slug: row.slug.clone(),
    holds,
    read_when,
    path: row.path.clone(),
    changed_at,
    body,
  }
}

fn person_entry(row: &Fragment) -> IndexEntry {
  IndexEntry {
    slug: row.slug.clone(),
    holds: row.title.trim().to_owned(),
    read_when: Some("when they speak or are spoken of".to_owned()),
    path: row.path.clone(),
    changed_at: day_ms(row.confirmed_on.as_deref()).max(day_ms(row.written_on.as_deref())),
    body: row.owner.map_or(Body::Text(String::new()), Body::Person),
  }
}

fn condition_entry(chat_id: i64, row: &Condition) -> IndexEntry {
  IndexEntry {
    slug: row.slug.clone(),
    holds: row.action.trim().to_owned(),
    read_when: Some(row.condition.trim().to_owned()).filter(|when| !when.is_empty()),
    path: format!("rooms/{chat_id}/situations/{}", row.slug),
    changed_at: None,
    body: Body::Text(format!("When {}: {}", row.condition.trim(), row.action.trim())),
  }
}

fn memory_entry(chat_id: i64, row: &MemoryRow) -> IndexEntry {
  IndexEntry {
    slug: row.slug.clone(),
    holds: memories::index_title(row),
    read_when: Some(row.condition.trim().to_owned()).filter(|when| !when.is_empty()),
    path: format!("memories/{chat_id}/{}", row.slug),
    changed_at: Some(row.moved_at.unwrap_or(row.set_at).max(row.set_at)),
    body: Body::Text(row.action.clone()),
  }
}

/// One group's entries for the agent in the room, in the order the brain gives them.
pub async fn entries(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  group: &str,
) -> Result<Vec<IndexEntry>, Unanswered> {
  let rows = |kind: &'static str| async move {
    fragments::rows(reference, agent, chat_id, kind).await.map_err(Unanswered::Unit)
  };

  Ok(match group {
    "system-documents" => {
      let shipped = rows(SYSTEM_DOCUMENT).await?;
      let lore = rows(LORE).await?;

      shipped
        .iter()
        .map(|row| fragment_entry(row, Body::Shipped))
        .chain(lore.iter().map(|row| fragment_entry(row, Body::Lore)))
        .collect()
    }
    "room-rules" => {
      let rules = rows(ROOM_RULE).await?;
      let conditions = memories::candidates(reference, chat_id, agent).await.map_err(Unanswered::Unit)?;

      rules
        .iter()
        .map(|row| fragment_entry(row, Body::Knowledge))
        .chain(conditions.iter().map(|row| condition_entry(chat_id, row)))
        .collect()
    }
    "knowledge" => rows(KNOWLEDGE).await?.iter().map(|row| fragment_entry(row, Body::Knowledge)).collect(),
    "people" => rows(PERSON_BOOK).await?.iter().map(person_entry).collect(),
    "room-memories" => memories::standing(reference, chat_id, agent)
      .await
      .iter()
      .map(|row| memory_entry(chat_id, row))
      .collect(),
    other => return Err(Unanswered::NoGroup(other.to_owned())),
  })
}

// The paths the session already holds; none where no session is named.
async fn held(reference: &Reference, session: Option<&str>) -> Result<HashSet<String>, Unanswered> {
  let Some(session) = session else {
    return Ok(HashSet::new());
  };
  let loads = reference.stages.runs.agency.session_loads(session).await.map_err(Unanswered::Unit)?;

  Ok(loads.into_iter().map(|load| load.path).collect())
}

/// The index for the agent in the room: every group in order, each with its unread count against the session's
/// loads and its hint.
pub async fn index(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  session: Option<&str>,
  now: i64,
) -> Result<Vec<Group>, Unanswered> {
  let held = held(reference, session).await?;
  let mut groups = vec![];

  for group in GROUPS {
    let entries = entries(reference, agent, chat_id, group).await?;
    let unread = entries.iter().filter(|entry| !held.contains(&entry.path)).count();
    let changed = entries
      .iter()
      .filter(|entry| entry.changed_at.is_some_and(|at| now - at <= FRESH_MS))
      .count();
    let hint = match changed {
      0 => None,
      1 => Some("1 entry changed in the last three days.".to_owned()),
      count => Some(format!("{count} entries changed in the last three days.")),
    };

    groups.push(Group {
      group,
      unread,
      hint,
      entries,
    });
  }

  Ok(groups)
}

/// One piece read whole by its slug within its group, recorded among the session's loads where one is named.
pub async fn piece(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  group: &str,
  slug: &str,
  session: Option<&str>,
) -> Result<Piece, Unanswered> {
  let entry = entries(reference, agent, chat_id, group)
    .await?
    .into_iter()
    .find(|entry| entry.slug == slug)
    .ok_or(Unanswered::NoPiece)?;
  let slugs = [slug.to_owned()];
  let (path, text) = match &entry.body {
    Body::Text(text) => (entry.path.clone(), text.clone()),
    Body::Shipped => {
      let text = reference
        .shipped
        .as_ref()
        .and_then(|root| std::fs::read_to_string(root.join(&entry.path)).ok())
        .unwrap_or_default();

      (entry.path.clone(), text)
    }
    Body::Knowledge => {
      match reference.brain.knowledge(agent, chat_id, &slugs).await.map_err(Unanswered::Unit)? {
        Reply::Answered(documents) => documents
          .into_iter()
          .next()
          .map(|document| (document.path, document.text))
          .ok_or(Unanswered::NoPiece)?,
        Reply::Refused(_) => return Err(Unanswered::NoPiece),
      }
    }
    Body::Lore => reference
      .brain
      .lore(agent, &slugs)
      .await
      .map_err(Unanswered::Unit)?
      .into_iter()
      .next()
      .map(|document| (document.path, document.text))
      .ok_or(Unanswered::NoPiece)?,
    Body::Person(owner) => reference
      .brain
      .sheets(agent, chat_id, &[*owner], None)
      .await
      .map_err(Unanswered::Unit)?
      .into_iter()
      .next()
      .map(|sheet| (sheet.path, held_sheet(&sheet.text)))
      .ok_or(Unanswered::NoPiece)?,
  };
  let text = text.trim().to_owned();

  if let Some(session) = session {
    let agency = &reference.stages.runs.agency;
    let mut loads: Vec<Load> = agency.session_loads(session).await.map_err(Unanswered::Unit)?;

    // The load stands under the entry's path, the one the index counts read by.
    loads.retain(|load| load.path != entry.path);
    loads.push(Load {
      path: entry.path.clone(),
      version: bun_hash(&text).to_string(),
    });
    agency.keep_loads(session, &loads).await.map_err(Unanswered::Unit)?;
  }

  Ok(Piece {
    slug: entry.slug,
    group: group.to_owned(),
    path,
    text,
  })
}

// The words a text is matched by: its runs of letters and digits, lowered.
fn words_of(text: &str) -> Vec<String> {
  text
    .split(|character: char| !character.is_alphanumeric())
    .filter(|word| !word.is_empty())
    .map(str::to_lowercase)
    .collect()
}

/// The entries of every group whose words match the query's, the ones holding the most of them first, at most
/// `limit`.
pub async fn search(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  query: &str,
  limit: usize,
) -> Result<Vec<(&'static str, IndexEntry)>, Unanswered> {
  let asked: HashSet<String> = words_of(query).into_iter().collect();
  let mut found: Vec<(usize, usize, &'static str, IndexEntry)> = vec![];
  let mut order = 0;

  for group in GROUPS {
    for entry in entries(reference, agent, chat_id, group).await? {
      let said: HashSet<String> = words_of(&format!(
        "{} {} {}",
        entry.slug,
        entry.holds,
        entry.read_when.as_deref().unwrap_or_default()
      ))
      .into_iter()
      .collect();
      let matched = asked.iter().filter(|word| said.iter().any(|one| one.contains(word.as_str()))).count();

      if matched > 0 {
        found.push((matched, order, group, entry));
      }

      order += 1;
    }
  }

  found.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
  found.truncate(limit);

  Ok(found.into_iter().map(|(_, _, group, entry)| (group, entry)).collect())
}
