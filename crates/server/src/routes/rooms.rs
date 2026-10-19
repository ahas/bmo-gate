//! A room's judgements for the console (`docs/boundary-api.md`, 「For the console」): a page of them newest first,
//! each with the roads its run walked and what its round's gates were offered.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use gate_store::entity::{gate_roads, judgements, reference_offers};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::App;
use crate::answer::{Answered, Query, Refused};

/// A page's length where `limit` names none, and the most it may be.
pub const PAGE: u64 = 100;
pub const MOST: u64 = 500;

/// How far either side of the time a judgement took one of its roads may stand, in seconds.
const SLACK: i64 = 5;

/// A page's length as asked: a hundred where none is named, at least one and five hundred at most.
pub fn page(limit: Option<i64>) -> u64 {
  limit.map_or(PAGE, |limit| limit.clamp(1, MOST as i64) as u64)
}

/// A judgement as the event stream and the room's page carry it.
pub fn judgement_body(row: &judgements::Model) -> Value {
  json!({
    "id": row.id,
    "chat": row.chat_id,
    "message": row.message_id,
    "stage": row.stage,
    "verdict": row.verdict,
    "detail": row.detail,
    "created_at": row.created_at,
    "ms": row.ms,
    "round": row.round,
  })
}

// The seconds a judgement's roads may stand within.
fn window(row: &judgements::Model) -> (i64, i64) {
  let took = (row.ms.unwrap_or(0).max(0) as u64).div_ceil(1000) as i64;

  (row.created_at - took - SLACK, row.created_at + SLACK)
}

/// Whether a road is one of a judgement's: its stage's, of the same round, or of the same message where either
/// names no round, and within the time the judgement took.
pub fn walked_for(road: &gate_roads::Model, row: &judgements::Model) -> bool {
  let (from, to) = window(row);
  let same = match (&road.round, &row.round) {
    (Some(road), Some(judged)) => road == judged,
    _ => row.message_id.is_some() && road.message_id == row.message_id,
  };

  road.stage == row.stage && same && (from..=to).contains(&road.created_at)
}

fn road_body(road: &gate_roads::Model) -> Value {
  let tokens = road.input_tokens.map(|input| {
    json!({
      "input_tokens": input,
      "output_tokens": road.output_tokens,
      "cache_read_tokens": road.cache_read_tokens,
      "cache_write_tokens": road.cache_write_tokens,
    })
  });

  json!({
    "id": road.id,
    "provider": road.provider,
    "model": road.model,
    "outcome": road.outcome,
    "ms": road.ms,
    "tokens": tokens,
  })
}

fn offer_body(offer: &reference_offers::Model) -> Value {
  let rules: Option<Value> = offer.rules.as_deref().and_then(|rules| serde_json::from_str(rules).ok());

  json!({
    "stage": offer.stage,
    "held": offer.held,
    "asked": offer.asked,
    "kept": { "item": offer.by_item, "keyword": offer.by_keyword, "person": offer.by_person },
    "capped": offer.capped,
    "rules": rules,
  })
}

#[derive(Deserialize)]
pub struct Page {
  #[serde(default)]
  pub before: Option<i64>,
  #[serde(default)]
  pub limit: Option<i64>,
}

pub async fn judgements(
  State(app): State<Arc<App>>,
  Path(chat): Path<i64>,
  Query(asked): Query<Page>,
) -> Answered<Json<Value>> {
  let db = &app.stages.runs.db;
  let limit = page(asked.limit);
  let mut found = judgements::Entity::find().filter(judgements::Column::ChatId.eq(chat));

  if let Some(before) = asked.before {
    found = found.filter(judgements::Column::Id.lt(before));
  }

  let mut rows = found
    .order_by_desc(judgements::Column::Id)
    .limit(limit + 1)
    .all(db)
    .await
    .map_err(Refused::database)?;
  let has_more = rows.len() as u64 > limit;

  rows.truncate(limit as usize);

  let (from, to) = rows
    .iter()
    .map(window)
    .fold((i64::MAX, i64::MIN), |(from, to), (low, high)| (from.min(low), to.max(high)));
  let roads = if rows.is_empty() {
    vec![]
  } else {
    gate_roads::Entity::find()
      .filter(gate_roads::Column::ChatId.eq(chat))
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
      .filter(reference_offers::Column::ChatId.eq(chat))
      .filter(reference_offers::Column::Round.is_in(rounds))
      .order_by_asc(reference_offers::Column::Id)
      .all(db)
      .await
      .map_err(Refused::database)?
  };
  let mut offered: HashMap<&str, Vec<Value>> = HashMap::new();

  for offer in &offers {
    if let Some(round) = offer.round.as_deref() {
      offered.entry(round).or_default().push(offer_body(offer));
    }
  }

  // Each road goes to one judgement: the oldest of the page whose run it can be.
  let mut taken = HashSet::new();
  let mut walked: HashMap<i64, Vec<Value>> = HashMap::new();

  for row in rows.iter().rev() {
    for road in &roads {
      if !taken.contains(&road.id) && walked_for(road, row) {
        taken.insert(road.id);
        walked.entry(row.id).or_default().push(road_body(road));
      }
    }
  }

  let judgements: Vec<Value> = rows
    .iter()
    .map(|row| {
      let mut body = judgement_body(row);

      body["roads"] = walked.remove(&row.id).unwrap_or_default().into();
      body["offers"] = row
        .round
        .as_deref()
        .and_then(|round| offered.get(round))
        .cloned()
        .unwrap_or_default()
        .into();
      body
    })
    .collect();

  Ok(Json(json!({ "judgements": judgements, "has_more": has_more })))
}
