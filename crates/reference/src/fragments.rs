//! The fragment rows the reference road is offered (the brain's `docs/fragments.md`; `docs/reference-selection.md`):
//! the rows a turn's agent may be offered in a room, each written out as the index line its gate reads, and what
//! the road writes back — the rows a turn attached handed to the brain to count, what each gate was offered, and
//! each candidate's verdicts in the gate's own record.

use std::sync::LazyLock;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use gate_markup::js;
use gate_markup::text::period_of;
use gate_ports::PortError;
use gate_ports::brain::{self, Hit};
use gate_runs::records::now;
use regex::Regex;
use sea_orm::{DatabaseConnection, DbErr};

use crate::Reference;
use gate_stages::sql::run;

/// One fragment row as a gate is offered it, under a number the road tells it apart by within a turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fragment {
  pub id: i64,
  /// The brain's own key for the row, which a hit names it by.
  pub key: String,
  pub kind: String,
  pub chat_id: Option<i64>,
  pub owner: Option<i64>,
  pub slug: String,
  pub title: String,
  pub path: String,
  pub scope: Option<String>,
  /// The heading of the brain's table of contents the row stands under, where its library has headings.
  pub section: Option<String>,
  pub position: i64,
  pub keywords: Vec<String>,
  pub items: Vec<i64>,
  pub written_on: Option<String>,
  pub confirmed_on: Option<String>,
  pub status: String,
}

// The numbers rows are told apart by in this service.
static NEXT: AtomicI64 = AtomicI64::new(1);

impl Fragment {
  /// A row as the brain answers it, under a number of its own.
  pub fn of(row: brain::Fragment) -> Self {
    Self {
      id: NEXT.fetch_add(1, Ordering::Relaxed),
      key: row.key,
      kind: row.kind,
      chat_id: row.chat_id,
      owner: row.owner,
      slug: row.slug,
      title: row.title,
      path: row.path,
      scope: row.scope,
      section: row.section,
      position: row.position,
      keywords: row.keywords,
      items: row.items,
      written_on: row.written_on,
      confirmed_on: row.confirmed_on,
      status: row.status,
    }
  }

  /// The row as the brain finds it again to count what a turn attached.
  pub fn hit(&self) -> Hit {
    Hit {
      key: self.key.clone(),
      kind: self.kind.clone(),
      chat_id: self.chat_id,
      owner: self.owner,
      slug: self.slug.clone(),
    }
  }
}

/// The active rows of one kind the turn's agent may be offered in the room — its own and those marked for every
/// agent — in the order the brain gives them.
pub async fn rows(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  kind: &str,
) -> Result<Vec<Fragment>, PortError> {
  let kinds = [kind.to_owned()];
  let rows = reference.brain.offered(agent, chat_id, &kinds).await?;

  Ok(rows.into_iter().filter(|row| row.kind == kind).map(Fragment::of).collect())
}

/// The rows a turn attached handed to the brain, which counts each on its row.
pub async fn hits(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  attached: &[Fragment],
) -> Result<(), PortError> {
  if attached.is_empty() {
    return Ok(());
  }

  let hits: Vec<Hit> = attached.iter().map(Fragment::hit).collect();

  reference.brain.hits(agent, chat_id, &hits).await
}

/// One row as its index line: the slug, the bracket its library carries where it has one, its title, and the
/// months its days span where it carries any.
pub fn index_line(row: &Fragment) -> String {
  let period = period_of(row.written_on.as_deref(), row.confirmed_on.as_deref());

  format!(
    "- {}{} \u{2014} {}{}",
    row.slug,
    row.scope.as_deref().map_or_else(String::new, |scope| format!(" {scope}")),
    row.title,
    period.map_or_else(String::new, |period| format!(" \u{b7} {period}")),
  )
}

/// One entry of an index: its slug, what its line says the piece is about, and the bracket the line carries
/// where its library writes one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexEntry {
  pub slug: String,
  pub title: String,
  pub tag: Option<String>,
}

static ENTRY_LINE: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(&format!(
    r"^- ([a-z0-9-]+)(?:[{0}]+(\[[^\]]*\]))?[{0}]+\u{{2014}}[{0}]+({1}+)$",
    js::SPACE,
    js::DOT
  ))
  .expect("an index line")
});

/// The entries of one index in the order they stand, a slug named twice being the first line's.
pub fn index_entries(text: &str) -> Vec<IndexEntry> {
  let mut entries: Vec<IndexEntry> = vec![];

  for line in text.split('\n') {
    let Some(found) = ENTRY_LINE.captures(js::trim(line)) else { continue };

    if entries.iter().any(|entry| entry.slug == found[1]) {
      continue;
    }

    entries.push(IndexEntry {
      slug: found[1].to_owned(),
      title: found[3].to_owned(),
      tag: found.get(2).map(|tag| tag.as_str().to_owned()),
    });
  }

  entries
}

/// How many candidates each rule kept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Kept {
  pub item: i64,
  pub keyword: i64,
  pub person: i64,
}

/// What one gate was offered for a turn, once the narrowing ran.
pub struct Offer<'a> {
  pub stage: &'a str,
  pub chat_id: i64,
  pub message_id: Option<i64>,
  pub held: i64,
  pub kept: Kept,
  pub capped: i64,
  pub slugs: &'a [String],
  pub round: Option<&'a str>,
  pub rules: Option<&'a [&'a str]>,
}

pub async fn record_offer(db: &DatabaseConnection, offer: &Offer<'_>) -> Result<(), DbErr> {
  run(
    db,
    r#"INSERT INTO "reference_offers"
         ("stage", "chat_id", "message_id", "held", "asked", "by_item", "by_keyword", "by_person", "capped", "slugs", "created_at", "round", "rules")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)"#,
    vec![
      offer.stage.into(),
      offer.chat_id.into(),
      offer.message_id.into(),
      offer.held.into(),
      (offer.slugs.len() as i64).into(),
      offer.kept.item.into(),
      offer.kept.keyword.into(),
      offer.kept.person.into(),
      offer.capped.into(),
      serde_json::to_string(offer.slugs).unwrap_or_default().into(),
      now().into(),
      offer.round.map(str::to_owned).into(),
      offer.rules.map(|rules| serde_json::to_string(rules).unwrap_or_default()).into(),
    ],
  )
  .await
  .map(drop)
}

/// One candidate's verdicts for one run: what the gate's model and Laya said of it, and whether it reached the
/// prompt; a side left none is left as it stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
  pub stage: String,
  pub chat_id: i64,
  pub message_id: Option<i64>,
  pub slug: String,
  pub llm: Option<bool>,
  pub laya: Option<bool>,
  pub attached: Option<bool>,
}

// What the record keeps: the newest rows of each gate, none older than a year, swept every few thousand rows
// written by this service.
const KEEP_PER_STAGE: i64 = 100_000;
const KEEP_MS: i64 = 365 * 24 * 60 * 60 * 1_000;
const SWEEP_EVERY: usize = 2_000;

static SINCE_SWEEP: AtomicUsize = AtomicUsize::new(0);

/// The verdicts written, each side filled in where it says something; one that cannot be written is said and
/// lost.
pub async fn record_verdicts(db: &DatabaseConnection, rows: &[Verdict]) {
  if rows.is_empty() {
    return;
  }

  let now = now();
  let flag = |value: Option<bool>| value.map(i64::from);

  for row in rows {
    let written = run(
      db,
      r#"INSERT INTO "reference_verdicts" ("stage", "chat_id", "message_id", "slug", "llm", "laya", "attached", "created_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT ("stage", "chat_id", COALESCE("message_id", -1), "slug") DO UPDATE SET
           "llm" = COALESCE(excluded."llm", "reference_verdicts"."llm"),
           "laya" = COALESCE(excluded."laya", "reference_verdicts"."laya"),
           "attached" = COALESCE(excluded."attached", "reference_verdicts"."attached")"#,
      vec![
        row.stage.as_str().into(),
        row.chat_id.into(),
        row.message_id.into(),
        row.slug.as_str().into(),
        flag(row.llm).into(),
        flag(row.laya).into(),
        flag(row.attached).into(),
        now.into(),
      ],
    )
    .await;

    if let Err(why) = written {
      eprintln!("reference verdicts could not be recorded: {why}");
      return;
    }
  }

  if SINCE_SWEEP.fetch_add(rows.len(), Ordering::Relaxed) + rows.len() >= SWEEP_EVERY {
    SINCE_SWEEP.store(0, Ordering::Relaxed);
    sweep(db, now - KEEP_MS).await;
  }
}

// The verdicts and the offers past the newest of each gate or past their age taken away.
async fn sweep(db: &DatabaseConnection, before: i64) {
  for table in ["reference_verdicts", "reference_offers"] {
    let aged =
      run(db, &format!(r#"DELETE FROM "{table}" WHERE "created_at" < $1"#), vec![before.into()]).await;
    let crowded = run(
      db,
      &format!(
        r#"DELETE FROM "{table}" WHERE "id" IN (
             SELECT "id" FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "stage" ORDER BY "id" DESC) AS "place" FROM "{table}") AS "ranked"
             WHERE "place" > $1)"#
      ),
      vec![KEEP_PER_STAGE.into()],
    )
    .await;

    if let Some(why) = aged.err().or(crowded.err()) {
      eprintln!("the {table} could not be swept: {why}");
    }
  }
}
