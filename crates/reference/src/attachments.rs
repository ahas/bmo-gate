//! What the reference gates attach, watched by the gate (`docs/reference-selection.md`, 「Watching what attaches」):
//! each gate's turns over the last day counted out of the verdict record, and a piece attached on more than its
//! share of them, over the day and over its latest half, raised as a row through bmo-job for a job to fix, and the
//! owner's room told through the receiver's owner notice. When each piece was last raised is kept in the watch's
//! own file, so a restart does not raise it again within its quiet day.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use gate_policy::fill_marks;
use gate_ports::PortError;
use gate_ports::job::Job;
use gate_words::attachments as words;
use sea_orm::{ConnectionTrait, DbErr};
use serde_json::{Map, Value, json};

use crate::Reference;
use gate_stages::sql::all;

/// The stages the reference gates record their verdicts under: the three that pick out of a library and the
/// person book's search. The situation gate records into the same table and is not watched.
pub const STAGES: [&str; 4] = ["system-documents", "room-rules", "library-knowledge", "people-search"];

// Past this share of its gate's turns a piece is raised, once the gate has been asked often enough for a share to
// mean anything.
pub const ALARM_SHARE: f64 = 0.3;
pub const ALARM_MINIMUM: usize = 20;

// The window the shares are counted over, its latest part the share has to hold over as well, and how long a
// piece raised is left alone after.
pub const WINDOW_SECONDS: i64 = 24 * 60 * 60;
pub const RECENT_SECONDS: i64 = WINDOW_SECONDS / 2;
pub const QUIET_SECONDS: i64 = 24 * 60 * 60;

/// The code the owner's room is told of a raised row under.
pub const NOTICE: &str = "attachment-alarm";

/// One candidate's answer as the verdict record keeps it: which turn, which gate, whether it attached,
/// when, in seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct AttachRow {
  pub stage: String,
  pub chat_id: i64,
  pub message_id: Option<i64>,
  pub slug: String,
  pub attached: Option<bool>,
  pub at: i64,
}

/// How often one piece reached the prompt against how many turns its gate was asked.
#[derive(Clone, Debug, PartialEq)]
pub struct Share {
  pub stage: String,
  pub slug: String,
  pub asked: usize,
  pub attached: usize,
  pub share: f64,
}

/// A piece past the line: its share over the whole window, and over the window's latest part.
#[derive(Clone, Debug, PartialEq)]
pub struct Alarm {
  pub share: Share,
  pub recent: Share,
}

impl Alarm {
  /// The key a piece is raised and remembered under.
  pub fn key(&self) -> String {
    format!("reference-attach:{}:{}", self.share.stage, self.share.slug)
  }
}

/// Turns, each by its room and the message it answered.
type Turns = BTreeSet<(i64, Option<i64>)>;

/// Every piece's share of its gate's turns, the largest first.
pub fn shares(rows: &[AttachRow]) -> Vec<Share> {
  let mut turns: BTreeMap<&str, Turns> = BTreeMap::new();
  let mut hits: BTreeMap<(&str, &str), Turns> = BTreeMap::new();

  for row in rows {
    let turn = (row.chat_id, row.message_id);

    turns.entry(&row.stage).or_default().insert(turn);

    if row.attached == Some(true) {
      hits.entry((&row.stage, &row.slug)).or_default().insert(turn);
    }
  }

  let mut shares: Vec<Share> = hits
    .into_iter()
    .map(|((stage, slug), attached)| {
      let asked = turns.get(stage).map_or(0, BTreeSet::len);

      Share {
        stage: stage.to_owned(),
        slug: slug.to_owned(),
        asked,
        attached: attached.len(),
        share: if asked == 0 { 0.0 } else { attached.len() as f64 / asked as f64 },
      }
    })
    .collect();

  shares.sort_by(|left, right| {
    right
      .share
      .total_cmp(&left.share)
      .then_with(|| left.stage.cmp(&right.stage))
      .then_with(|| left.slug.cmp(&right.slug))
  });

  shares
}

/// The pieces past the line: over the window on a gate asked often enough, and over its latest part
/// too. A fix goes live in the middle of a window, and a piece past the line only on the turns before
/// it has already come down.
pub fn alarms(rows: &[AttachRow], now: i64) -> Vec<Alarm> {
  let late: Vec<AttachRow> = rows.iter().filter(|row| row.at >= now - RECENT_SECONDS).cloned().collect();
  let recent = shares(&late);

  shares(rows)
    .into_iter()
    .filter_map(|share| {
      let late = recent.iter().find(|one| one.stage == share.stage && one.slug == share.slug)?;

      (share.asked >= ALARM_MINIMUM && share.share > ALARM_SHARE && late.share > ALARM_SHARE).then(|| {
        Alarm {
          recent: late.clone(),
          share,
        }
      })
    })
    .collect()
}

fn percent(share: f64) -> String {
  format!("{}%", (share * 100.0).round())
}

/// The title of the row a piece past the line is raised as.
pub fn row_title(alarm: &Alarm) -> String {
  fill_marks(words::TITLE, &[("stage", &alarm.share.stage), ("slug", &alarm.share.slug)])
}

/// What the row says for itself: the shares, where the fault usually lies, and what its job does.
pub fn judgement(alarm: &Alarm) -> String {
  let Alarm { share, recent } = alarm;
  let shares = fill_marks(
    words::SHARES,
    &[
      ("stage", &share.stage),
      ("slug", &share.slug),
      ("attached", &share.attached.to_string()),
      ("asked", &share.asked.to_string()),
      ("share", &percent(share.share)),
      ("recent_attached", &recent.attached.to_string()),
      ("recent_asked", &recent.asked.to_string()),
      ("recent_share", &percent(recent.share)),
      ("line", &percent(ALARM_SHARE)),
    ],
  );

  [shares.as_str(), words::CAUSE]
    .into_iter()
    .chain(words::STEPS)
    .collect::<Vec<_>>()
    .join("\n")
}

/// The verdict record of the watched gates since a moment, in seconds.
pub async fn rows(db: &impl ConnectionTrait, since: i64) -> Result<Vec<AttachRow>, DbErr> {
  let found = all(
    db,
    r#"SELECT "stage", "chat_id", "message_id", "slug", "attached", "created_at" FROM "reference_verdicts"
       WHERE "created_at" >= $1 AND "stage" IN ($2, $3, $4, $5)"#,
    [vec![since.into()], STAGES.iter().map(|&stage| stage.into()).collect()].concat(),
  )
  .await?;

  found
    .iter()
    .map(|row| {
      Ok(AttachRow {
        stage: row.try_get("", "stage")?,
        chat_id: row.try_get("", "chat_id")?,
        message_id: row.try_get("", "message_id")?,
        slug: row.try_get("", "slug")?,
        attached: row.try_get::<Option<i64>>("", "attached")?.map(|attached| attached != 0),
        at: row.try_get("", "created_at")?,
      })
    })
    .collect()
}

// When each piece was last raised, by its key, as the watch's file keeps it; none where the file holds none.
fn raised_at(file: &Path) -> BTreeMap<String, i64> {
  std::fs::read_to_string(file)
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default()
}

fn keep_raised(file: &Path, raised: &BTreeMap<String, i64>) {
  let written = file
    .parent()
    .map_or(Ok(()), std::fs::create_dir_all)
    .and_then(|()| std::fs::write(file, serde_json::to_string(raised).unwrap_or_default()));

  if let Err(why) = written {
    eprintln!("attachments: {} could not be written: {why}", file.display());
  }
}

/// Why a pass stopped short.
#[derive(Debug)]
pub enum Failed {
  Database(DbErr),
  Unit(PortError),
}

impl std::fmt::Display for Failed {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Failed::Database(why) => write!(f, "{why}"),
      Failed::Unit(why) => write!(f, "{why}"),
    }
  }
}

/// One pass: every piece past the line that has not been raised within the quiet time is raised in the owner's
/// room under its key — bmo-job answering the row it raised before where that one still stands open — the owner's
/// room told of each row raised now, and the piece marked as raised; the rows raised now.
pub async fn pass(
  reference: &Reference,
  job: &dyn Job,
  owner_chat: i64,
  file: &Path,
  now: i64,
) -> Result<Vec<i64>, Failed> {
  let found = rows(&reference.stages.runs.db, now - WINDOW_SECONDS).await.map_err(Failed::Database)?;
  let mut raised_before = raised_at(file);
  let mut raised = Vec::new();

  for alarm in alarms(&found, now) {
    let key = alarm.key();

    if raised_before.get(&key).is_some_and(|last| now - last < QUIET_SECONDS) {
      continue;
    }

    let title = row_title(&alarm);
    let row = job.raise(&title, &judgement(&alarm), owner_chat, &key).await.map_err(Failed::Unit)?;

    raised_before.insert(key, now);
    keep_raised(file, &raised_before);

    if !row.raised {
      continue;
    }

    let mut fields = Map::new();

    fields.insert("row".into(), json!(row.id));
    fields.insert("title".into(), Value::String(title));
    fields.insert("stage".into(), Value::String(alarm.share.stage.clone()));
    fields.insert("slug".into(), Value::String(alarm.share.slug.clone()));
    fields.insert("share".into(), json!(alarm.share.share));
    fields.insert("recent".into(), json!(alarm.recent.share));

    if let Err(why) = reference.receiver.owner_notice(NOTICE, &fields).await {
      eprintln!("attachments: the owner's room could not be told of row #{}: {why}", row.id);
    }

    raised.push(row.id);
  }

  Ok(raised)
}
