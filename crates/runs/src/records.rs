//! What a gate's run leaves in the gate's tables (`docs/gates.md`, 「What a judgement records」): a row for each
//! road it walked, with the tokens the road reported, and a judgement written into a room's log. A record the
//! database would not take is said and lost, never the gate's answer.

use std::time::SystemTime;

use gate_markup::js;
use gate_store::entity::{gate_roads, judgements};
use sea_orm::sea_query::Expr;
use sea_orm::{
  ActiveModelTrait, ActiveValue::Set, DatabaseConnection, DbErr, EntityTrait, NotSet, QuerySelect,
};
use serde_json::Value;
use tokio::time::Instant;

/// How one road of a run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
  Answered,
  TooLarge,
  Error,
  Unavailable,
  Stopped,
}

impl Outcome {
  pub fn word(self) -> &'static str {
    match self {
      Self::Answered => "answered",
      Self::TooLarge => "too-large",
      Self::Error => "error",
      Self::Unavailable => "unavailable",
      Self::Stopped => "stopped",
    }
  }
}

/// The tokens a road reported, summed over the models that answered on it; none where it reported none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Spent {
  pub input_tokens: Option<i64>,
  pub output_tokens: Option<i64>,
  pub cache_read_tokens: Option<i64>,
  pub cache_write_tokens: Option<i64>,
}

fn count(value: Option<&Value>) -> i64 {
  value.and_then(Value::as_i64).unwrap_or(0).max(0)
}

impl Spent {
  pub fn none() -> Self {
    Self::default()
  }

  /// What a completion's usage reports, in the gateway's words: the prompt's tokens less what the cache read
  /// and wrote of them, the completion's, and the cache's.
  pub fn of_usage(usage: Option<&Value>) -> Self {
    let Some(usage) = usage.filter(|usage| usage.is_object()) else { return Self::none() };
    let details = usage.get("prompt_tokens_details");
    let cache_read = count(details.and_then(|details| details.get("cached_tokens")));
    let cache_write = count(details.and_then(|details| details.get("cache_write_tokens")));

    Self {
      input_tokens: Some((count(usage.get("prompt_tokens")) - cache_read - cache_write).max(0)),
      output_tokens: Some(count(usage.get("completion_tokens"))),
      cache_read_tokens: Some(cache_read),
      cache_write_tokens: Some(cache_write),
    }
  }

  /// What a turn's reply spent, as its record reports each model it went out on: summed, none where it names
  /// no spend.
  pub fn of_spend(spend: &[Value]) -> Self {
    if spend.is_empty() {
      return Self::none();
    }

    let sum = |field: &str| Some(spend.iter().map(|one| count(one.get(field))).sum::<i64>());

    Self {
      input_tokens: sum("inputTokens"),
      output_tokens: sum("outputTokens"),
      cache_read_tokens: sum("cacheReadTokens"),
      cache_write_tokens: sum("cacheWriteTokens"),
    }
  }
}

/// Now, in epoch milliseconds.
pub fn now() -> i64 {
  SystemTime::now()
    .duration_since(SystemTime::UNIX_EPOCH)
    .map_or(0, |since| since.as_millis() as i64)
}

/// How long since a moment, in milliseconds.
pub fn elapsed_ms(since: Instant) -> i64 {
  since.elapsed().as_millis() as i64
}

/// One road a run walked: the gate, what it judged, the provider and model, how it ended — an outcome's word, the
/// gate's own or the agency's for a turn it carried — how long it held the run, what it spent, the round and the
/// run it belongs to.
pub struct Road<'a> {
  pub stage: &'a str,
  pub chat_id: Option<i64>,
  pub message_id: Option<i64>,
  pub provider: &'a str,
  pub model: &'a str,
  pub outcome: &'a str,
  pub ms: i64,
  pub spent: &'a Spent,
  pub round: Option<&'a str>,
  pub run: Option<&'a str>,
  /// How full the session's context window stood once the run ended, where a session reported it.
  pub context_ratio: Option<f64>,
  /// The number of the agency's event the road came in, none for a road the gate's own run walked.
  pub event: Option<i64>,
}

/// The road written; a road the database would not take is said and lost.
pub async fn road(db: &DatabaseConnection, road: &Road<'_>) {
  if let Err(why) = write_road(db, road).await {
    eprintln!("{}: its road could not be recorded: {why}", road.stage);
  }
}

/// The road written, or why the database would not take it.
pub async fn write_road(db: &DatabaseConnection, road: &Road<'_>) -> Result<(), DbErr> {
  let row = gate_roads::ActiveModel {
    id: NotSet,
    stage: Set(road.stage.to_owned()),
    chat_id: Set(road.chat_id),
    message_id: Set(road.message_id),
    provider: Set(road.provider.to_owned()),
    model: Set(road.model.to_owned()),
    outcome: Set(road.outcome.to_owned()),
    ms: Set(road.ms),
    created_at: Set(now()),
    input_tokens: Set(road.spent.input_tokens),
    output_tokens: Set(road.spent.output_tokens),
    cache_read_tokens: Set(road.spent.cache_read_tokens),
    cache_write_tokens: Set(road.spent.cache_write_tokens),
    round: Set(road.round.map(str::to_owned)),
    run: Set(road.run.map(str::to_owned)),
    rowid: NotSet,
    context_ratio: Set(road.context_ratio),
    event: Set(road.event),
  };

  row.insert(db).await.map(|_| ())
}

/// The newest number of the agency's events a road was written with, none where no road came in one.
pub async fn newest_event(db: &DatabaseConnection) -> Result<Option<i64>, DbErr> {
  let newest: Option<Option<i64>> = gate_roads::Entity::find()
    .select_only()
    .column_as(Expr::col(gate_roads::Column::Event).max(), "newest")
    .into_tuple()
    .one(db)
    .await?;

  Ok(newest.flatten())
}

/// An answer as a verdict line: its first line, cut with a mark past `most` characters, counted in UTF-16 units
/// as JavaScript counts a string's length.
pub fn verdict_line(answer: &str, most: usize) -> String {
  let line = js::trim(js::trim(answer).split('\n').next().unwrap_or_default()).to_owned();
  let units = js::chars(&line);

  if js::units(&line) > most {
    format!("{}\u{2026}", js::text(&units[..js::within(&units, most)]))
  } else {
    line
  }
}

/// One line a gate's model was asked of a candidate, exactly as the model read it, and what it answered of that
/// line; none where its answer was not read (`docs/gates.md`, 「What a turn records」).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AskedLine {
  pub line: String,
  pub answer: Option<String>,
}

/// What a gate decided about a room's message, as the room's log shows it: the verdict line, the whole of what
/// was answered or why nothing was, how long it took, the round it belongs to, and the lines its model was asked
/// of its candidates.
pub struct Judgement<'a> {
  pub chat_id: i64,
  pub message_id: Option<i64>,
  pub stage: &'a str,
  pub verdict: &'a str,
  pub detail: Option<&'a str>,
  pub ms: Option<i64>,
  pub round: Option<&'a str>,
  pub lines: &'a [AskedLine],
}

/// The lines a judgement row keeps, as written; none where it keeps none or they cannot be read.
pub fn lines_of(row: &judgements::Model) -> Vec<AskedLine> {
  row
    .lines
    .as_deref()
    .and_then(|lines| serde_json::from_str(lines).ok())
    .unwrap_or_default()
}

/// A decision written into the room's log, answering the row as written; one the database would not take is
/// said and lost.
pub async fn judgement(db: &DatabaseConnection, judgement: &Judgement<'_>) -> Option<judgements::Model> {
  let row = judgements::ActiveModel {
    id: NotSet,
    chat_id: Set(judgement.chat_id),
    message_id: Set(judgement.message_id),
    stage: Set(judgement.stage.to_owned()),
    verdict: Set(judgement.verdict.to_owned()),
    detail: Set(judgement.detail.map(str::to_owned)),
    created_at: Set(now()),
    ms: Set(judgement.ms),
    round: Set(judgement.round.map(str::to_owned)),
    rowid: NotSet,
    lines: Set(
      (!judgement.lines.is_empty()).then(|| serde_json::to_string(judgement.lines).unwrap_or_default()),
    ),
  };

  match row.insert(db).await {
    Ok(written) => Some(written),
    Err(why) => {
      eprintln!("{}: a judgement could not be recorded: {why}", judgement.stage);
      None
    }
  }
}
