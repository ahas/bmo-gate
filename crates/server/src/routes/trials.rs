//! A gate's trials from the console (`docs/boundary-api.md`, 「For the console」): one prompt put to one gate as a
//! turn would put it, kept with who asked and what came back, and a gate's trials read back oldest first.

use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::extract::{Path, State};
use gate_codes::Code;
use gate_runs::GateRequest;
use gate_runs::records::now;
use gate_store::entity::web_gate_chats;
use sea_orm::{
  ActiveModelTrait, ActiveValue, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde::{Deserialize, Serialize};

use crate::App;
use crate::answer::{Answered, Body, Query, Refused};
use crate::routes::console::gate;
use crate::routes::rooms::page;
use crate::routes::stages::instructions_of;

/// The most characters a trial's prompt may hold, as a turn takes no more.
pub const MOST_PROMPT_CHARS: usize = 1_000_000;

#[derive(Serialize)]
pub struct Trial {
  pub id: i64,
  pub stage: String,
  pub user: String,
  pub prompt: String,
  pub answer: Option<String>,
  pub ms: i64,
  pub created_at: i64,
}

impl From<web_gate_chats::Model> for Trial {
  fn from(row: web_gate_chats::Model) -> Self {
    Self {
      id: row.id,
      stage: row.stage,
      user: row.user_name,
      prompt: row.prompt,
      answer: row.answer,
      ms: row.ms,
      created_at: row.created_at,
    }
  }
}

#[derive(Deserialize)]
pub struct Asked {
  pub stage: String,
  pub prompt: String,
  pub user: String,
}

pub async fn trial(State(app): State<Arc<App>>, Body(asked): Body<Asked>) -> Answered<Json<Trial>> {
  gate(&asked.stage)?;

  if asked.prompt.chars().count() > MOST_PROMPT_CHARS {
    return Err(Refused::new(
      Code::PromptTooLong,
      format!("a trial's prompt holds at most {MOST_PROMPT_CHARS} characters"),
    ));
  }

  let runs = &app.stages.runs;
  let mut request = GateRequest::new(instructions_of(&asked.stage)?, asked.prompt.clone());

  request.agent = Some(runs.chat_agent.clone());

  let started = Instant::now();
  let answer = runs.run(&asked.stage, &request).await.map_err(Refused::of_run)?;
  let row = web_gate_chats::ActiveModel {
    id: ActiveValue::NotSet,
    stage: ActiveValue::Set(asked.stage),
    user_name: ActiveValue::Set(asked.user),
    prompt: ActiveValue::Set(asked.prompt),
    answer: ActiveValue::Set(answer),
    ms: ActiveValue::Set(started.elapsed().as_millis() as i64),
    created_at: ActiveValue::Set(now()),
    rowid: ActiveValue::NotSet,
    user_id: ActiveValue::Set(None),
  }
  .insert(&runs.db)
  .await
  .map_err(Refused::database)?;

  Ok(Json(row.into()))
}

#[derive(Deserialize)]
pub struct Page {
  #[serde(default)]
  pub limit: Option<i64>,
}

#[derive(Serialize)]
pub struct Trials {
  pub trials: Vec<Trial>,
}

pub async fn trials(
  State(app): State<Arc<App>>,
  Path(stage): Path<String>,
  Query(asked): Query<Page>,
) -> Answered<Json<Trials>> {
  gate(&stage)?;

  let mut rows = web_gate_chats::Entity::find()
    .filter(web_gate_chats::Column::Stage.eq(stage))
    .order_by_desc(web_gate_chats::Column::Id)
    .limit(page(asked.limit))
    .all(&app.stages.runs.db)
    .await
    .map_err(Refused::database)?;

  rows.reverse();

  Ok(Json(Trials {
    trials: rows.into_iter().map(Trial::from).collect(),
  }))
}
