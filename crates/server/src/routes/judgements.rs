//! A room's judgements (`docs/api.md`, 「Judgements」): one written, a round's attached to the message that
//! answered it, and a page read newest first with the roads each run walked and what its round's gates were
//! offered.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use bmo_gate_client::{
  AttachJudgements, Judgement, JudgementLine, JudgementQuery, KeptCounts, NewJudgement, Offer, Page, Road,
  Tokens,
};
use gate_runs::records;
use gate_store::entity::{gate_roads, judgements, reference_offers};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::json;

use crate::App;
use crate::answer::{Answered, Body, Query, Refused};

/// A page's length where `limit` names none, and the most it may be.
pub const PAGE: u64 = 100;
pub const MOST: u64 = 500;

/// How far either side of the time a judgement took one of its roads may stand, in milliseconds.
const SLACK: i64 = 5_000;

/// A page's length as asked: a hundred where none is named, at least one and five hundred at most.
pub fn page(limit: Option<i64>) -> u64 {
  limit.map_or(PAGE, |limit| limit.clamp(1, MOST as i64) as u64)
}

fn road_of(road: &gate_roads::Model) -> Road {
  Road {
    id: road.id,
    provider: road.provider.clone(),
    model: road.model.clone(),
    outcome: road.outcome.clone(),
    ms: road.ms,
    tokens: road.input_tokens.map(|input| Tokens {
      input_tokens: input,
      output_tokens: road.output_tokens,
      cache_read_tokens: road.cache_read_tokens,
      cache_write_tokens: road.cache_write_tokens,
    }),
  }
}

fn offer_of(offer: &reference_offers::Model) -> Offer {
  Offer {
    gate_name: offer.stage.clone(),
    held: offer.held,
    asked: offer.asked,
    kept: KeptCounts {
      item: offer.by_item,
      keyword: offer.by_keyword,
      word: offer.by_word,
      person: offer.by_person,
      recent: offer.by_recent,
    },
    capped: offer.capped,
    rules: offer.rules.as_deref().and_then(|rules| serde_json::from_str(rules).ok()),
  }
}

/// A judgement as the routes answer it, with no roads and no offers.
pub(crate) fn judgement_of(row: &judgements::Model) -> Judgement {
  Judgement {
    id: row.id,
    room_id: row.chat_id,
    message_id: row.message_id,
    gate_name: row.stage.clone(),
    verdict: row.verdict.clone(),
    detail: row.detail.clone(),
    created_at: row.created_at,
    ms: row.ms,
    round: row.round.clone(),
    lines: records::lines_of(row)
      .into_iter()
      .map(|asked| JudgementLine {
        line: asked.line,
        answer: asked.answer,
      })
      .collect(),
    roads: vec![],
    offers: vec![],
  }
}

// The milliseconds either side of a judgement that its roads may stand within.
fn window(row: &judgements::Model) -> (i64, i64) {
  (row.created_at - row.ms.unwrap_or(0).max(0) - SLACK, row.created_at + SLACK)
}

/// Whether a road is one of a judgement's: its gate's, of the same round, or of the same message where either
/// names no round, and within the time the judgement took.
fn walked_for(road: &gate_roads::Model, row: &judgements::Model) -> bool {
  let (from, to) = window(row);
  let same = match (&road.round, &row.round) {
    (Some(road), Some(judged)) => road == judged,
    _ => row.message_id.is_some() && road.message_id == row.message_id,
  };

  road.stage == row.stage && same && (from..=to).contains(&road.created_at)
}

pub async fn list(
  State(app): State<Arc<App>>,
  Query(asked): Query<JudgementQuery>,
) -> Answered<Json<Page<Judgement>>> {
  let db = &app.stages.runs.db;
  let limit = page(asked.limit);
  let mut found = judgements::Entity::find();

  if let Some(room_id) = asked.room_id {
    found = found.filter(judgements::Column::ChatId.eq(room_id));
  }
  if let Some(gate_name) = &asked.gate_name {
    found = found.filter(judgements::Column::Stage.eq(gate_name));
  }
  if let Some(from) = asked.from {
    found = found.filter(judgements::Column::CreatedAt.gte(from));
  }
  if let Some(to) = asked.to {
    found = found.filter(judgements::Column::CreatedAt.lte(to));
  }
  if let Some(before) = asked.before {
    found = found.filter(judgements::Column::Id.lt(before));
  }

  let mut rows = found
    .order_by_desc(judgements::Column::Id)
    .limit(limit + 1)
    .all(db)
    .await
    .map_err(Refused::database)?;
  let more = rows.len() as u64 > limit;

  rows.truncate(limit as usize);

  let (from, to) = rows
    .iter()
    .map(window)
    .fold((i64::MAX, i64::MIN), |(from, to), (low, high)| (from.min(low), to.max(high)));
  let rooms: HashSet<i64> = rows.iter().map(|row| row.chat_id).collect();
  let roads = if rows.is_empty() {
    vec![]
  } else {
    gate_roads::Entity::find()
      .filter(gate_roads::Column::ChatId.is_in(rooms.clone()))
      .filter(gate_roads::Column::CreatedAt.between(from, to))
      .order_by_asc(gate_roads::Column::Id)
      .all(db)
      .await
      .map_err(Refused::database)?
  };
  let rounds: HashSet<String> = rows.iter().filter_map(|row| row.round.clone()).collect();
  let offers = if rounds.is_empty() {
    vec![]
  } else {
    reference_offers::Entity::find()
      .filter(reference_offers::Column::ChatId.is_in(rooms))
      .filter(reference_offers::Column::Round.is_in(rounds))
      .order_by_asc(reference_offers::Column::Id)
      .all(db)
      .await
      .map_err(Refused::database)?
  };
  let mut offered: HashMap<&str, Vec<Offer>> = HashMap::new();

  for offer in &offers {
    if let Some(round) = offer.round.as_deref() {
      offered.entry(round).or_default().push(offer_of(offer));
    }
  }

  // Each road goes to one judgement: the oldest of the page whose run it can be.
  let mut taken = HashSet::new();
  let mut walked: HashMap<i64, Vec<Road>> = HashMap::new();

  for row in rows.iter().rev() {
    for road in &roads {
      if !taken.contains(&road.id) && walked_for(road, row) {
        taken.insert(road.id);
        walked.entry(row.id).or_default().push(road_of(road));
      }
    }
  }

  let items: Vec<Judgement> = rows
    .iter()
    .map(|row| {
      let mut body = judgement_of(row);

      body.roads = walked.remove(&row.id).unwrap_or_default();
      body.offers = row.round.as_deref().and_then(|round| offered.get(round)).cloned().unwrap_or_default();
      body
    })
    .collect();

  Ok(Json(Page::of(items, more)))
}

pub async fn add(
  State(app): State<Arc<App>>,
  Body(judged): Body<NewJudgement>,
) -> Answered<(StatusCode, Json<Judgement>)> {
  let written = records::judgement(
    &app.stages.runs.db,
    &records::Judgement {
      chat_id: judged.room_id,
      message_id: judged.message_id,
      stage: &judged.gate_name,
      verdict: &judged.verdict,
      detail: judged.detail.as_deref(),
      ms: judged.ms,
      round: judged.round.as_deref(),
      lines: &[],
    },
  )
  .await
  .ok_or_else(|| Refused::database("the judgement was not written"))?;
  let body = judgement_of(&written);

  app
    .stages
    .publish("judgement.created", serde_json::to_value(&body).unwrap_or(json!({})));

  Ok((StatusCode::CREATED, Json(body)))
}

pub async fn attached(
  State(app): State<Arc<App>>,
  Body(attach): Body<AttachJudgements>,
) -> Answered<StatusCode> {
  gate_stages::sql::run(
    &app.stages.runs.db,
    r#"UPDATE "judgements" SET "message_id" = $1 WHERE "chat_id" = $2 AND "created_at" >= $3 AND "message_id" IS NULL"#,
    vec![attach.message_id.into(), attach.room_id.into(), attach.since.into()],
  )
  .await
  .map_err(Refused::database)?;

  Ok(StatusCode::NO_CONTENT)
}
