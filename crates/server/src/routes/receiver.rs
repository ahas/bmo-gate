//! For bmo-receiver (`docs/boundary-api.md`, 「For bmo-receiver」): a turn's reference, words through the sanitiser,
//! a room's judgements written and a round's put under the message that answered it, and a companion's gate options
//! copied.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use gate_ports::brain::Event;
use gate_reference::road::{Turn, select};
use gate_reference::{Entry, RoomKind, SituationTurn};
use gate_runs::options;
use gate_runs::records::{self, Judgement, now};
use gate_stages::sanitizer::sanitise;
use gate_stages::sql::run;
use serde::{Deserialize, Serialize};

use crate::App;
use crate::answer::{Answered, Body, Refused};
use crate::routes::rooms::judgement_body;

#[derive(Deserialize)]
pub struct TurnEvent {
  pub kind: String,
  #[serde(default)]
  pub item: Option<i64>,
}

#[derive(Deserialize)]
pub struct Situation {
  pub agent: String,
  pub room: RoomKind,
  pub events: Vec<TurnEvent>,
  pub now: i64,
}

/// A turn's envelope, as the receiver hands it over.
#[derive(Deserialize)]
pub struct Envelope {
  pub chat: i64,
  #[serde(default)]
  pub message: Option<i64>,
  pub lines: Vec<String>,
  pub speakers: Vec<i64>,
  #[serde(default)]
  pub situation: Option<Situation>,
  #[serde(default)]
  pub holds: Option<Vec<String>>,
  #[serde(default)]
  pub round: Option<String>,
  pub people_spoke: bool,
  #[serde(default)]
  pub answered: Option<String>,
  #[serde(default)]
  pub off: Vec<String>,
  #[serde(default)]
  pub lore: Option<bool>,
  pub records: bool,
}

#[derive(Serialize)]
pub struct Entries {
  pub entries: Vec<Entry>,
}

/// The turn the envelope stands for.
pub fn turn_of(envelope: Envelope) -> Turn {
  let situation = envelope.situation.map(|situation| SituationTurn {
    chat_id: envelope.chat,
    agent: situation.agent,
    message_id: envelope.message,
    room: situation.room,
    message_lines: envelope.lines.clone(),
    events: situation
      .events
      .into_iter()
      .map(|event| Event {
        kind: event.kind,
        item: event.item,
      })
      .collect(),
    round: envelope.round.clone(),
    now: situation.now,
  });

  Turn {
    chat_id: envelope.chat,
    message_lines: envelope.lines,
    message_id: envelope.message,
    speaker_ids: envelope.speakers,
    situation,
    holds: envelope.holds.map(|holds| holds.into_iter().collect::<HashSet<_>>()),
    round: envelope.round,
    people_spoke: envelope.people_spoke,
    answered: envelope.answered,
    off: envelope.off,
    lore: envelope.lore.unwrap_or(true),
    records: envelope.records,
  }
}

pub async fn reference(
  State(app): State<Arc<App>>,
  Body(envelope): Body<Envelope>,
) -> Answered<Json<Entries>> {
  let entries = select(&app.reference, &turn_of(envelope)).await.map_err(Refused::of_run)?;

  Ok(Json(Entries { entries }))
}

#[derive(Deserialize)]
pub struct Sanitise {
  pub text: String,
  pub label: String,
  #[serde(default)]
  pub chat: Option<i64>,
  #[serde(default)]
  pub message: Option<i64>,
}

#[derive(Serialize)]
pub struct Sanitised {
  pub text: String,
  pub changed: bool,
}

pub async fn sanitised(
  State(app): State<Arc<App>>,
  Body(asked): Body<Sanitise>,
) -> Answered<Json<Sanitised>> {
  let safe = sanitise(&app.stages, &asked.text, &asked.label, asked.chat, asked.message)
    .await
    .map_err(Refused::of_run)?;

  Ok(Json(Sanitised {
    text: safe.text,
    changed: safe.changed,
  }))
}

#[derive(Deserialize)]
pub struct Judged {
  pub chat: i64,
  #[serde(default)]
  pub message: Option<i64>,
  pub stage: String,
  pub verdict: String,
  #[serde(default)]
  pub detail: Option<String>,
  #[serde(default)]
  pub ms: Option<i64>,
  #[serde(default)]
  pub round: Option<String>,
}

pub async fn judgement(State(app): State<Arc<App>>, Body(judged): Body<Judged>) -> Answered<StatusCode> {
  let written = records::judgement(
    &app.stages.runs.db,
    &Judgement {
      chat_id: judged.chat,
      message_id: judged.message,
      stage: &judged.stage,
      verdict: &judged.verdict,
      detail: judged.detail.as_deref(),
      ms: judged.ms,
      round: judged.round.as_deref(),
    },
  )
  .await
  .ok_or_else(|| Refused::database("the judgement was not written"))?;

  app.stages.publish("judgement", judgement_body(&written));

  Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Attach {
  pub chat: i64,
  pub message: i64,
  pub since: i64,
}

pub async fn attached(State(app): State<Arc<App>>, Body(attach): Body<Attach>) -> Answered<StatusCode> {
  run(
    &app.stages.runs.db,
    r#"UPDATE "judgements" SET "message_id" = $1 WHERE "chat_id" = $2 AND "created_at" >= $3 AND "message_id" IS NULL"#,
    vec![attach.message.into(), attach.chat.into(), attach.since.into()],
  )
  .await
  .map_err(Refused::database)?;

  Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Copied {
  pub agent: String,
  pub from: String,
}

pub async fn copied(State(app): State<Arc<App>>, Body(copied): Body<Copied>) -> Answered<StatusCode> {
  options::copy(&app.stages.runs.db, &copied.agent, &copied.from, now())
    .await
    .map_err(Refused::database)?;

  Ok(StatusCode::NO_CONTENT)
}
