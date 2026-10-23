//! Trials (`docs/api.md`, 「Trials」): one prompt put to one gate as a turn would put it, kept with who asked and
//! what came back, and a gate's trials read back oldest first; a console's reader puts them too (「Console」).

use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use bmo_gate_client::{ConsoleTrial, NewTrial, Page, Trial, TrialQuery};
use gate_codes::Code;
use gate_runs::GateRequest;
use gate_runs::records::now;
use gate_store::entity::web_gate_chats;
use sea_orm::{
  ActiveModelTrait, ActiveValue, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};

use crate::App;
use crate::answer::{Answered, Body, Query, Refused};
use crate::console::OWNER_KEY;
use crate::routes::gates::{gate, instructions_of};
use crate::routes::judgements::page;

/// The most characters a trial's prompt may hold, as a turn takes no more.
pub const MOST_PROMPT_CHARS: usize = 1_000_000;

fn trial_of(row: web_gate_chats::Model) -> Trial {
  Trial {
    id: row.id,
    gate_name: row.stage,
    user_name: row.user_name,
    prompt: row.prompt,
    answer: row.answer,
    ms: row.ms,
    created_at: row.created_at,
  }
}

pub async fn add(
  State(app): State<Arc<App>>,
  Body(asked): Body<NewTrial>,
) -> Answered<(StatusCode, Json<Trial>)> {
  put(&app, asked.gate_name, asked.prompt, asked.user_name, None).await
}

/// A trial put through a console (`docs/api.md`, 「Console」): kept with no user name, under the reader's owner key
/// where the call carries one.
pub async fn add_from_console(
  State(app): State<Arc<App>>,
  headers: HeaderMap,
  Body(asked): Body<ConsoleTrial>,
) -> Answered<(StatusCode, Json<Trial>)> {
  let owner = headers
    .get(OWNER_KEY)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.parse::<i64>().ok());

  put(&app, asked.gate_name, asked.prompt, String::new(), owner).await
}

async fn put(
  app: &App,
  gate_name: String,
  prompt: String,
  user_name: String,
  user_id: Option<i64>,
) -> Answered<(StatusCode, Json<Trial>)> {
  gate(&gate_name)?;

  if prompt.chars().count() > MOST_PROMPT_CHARS {
    return Err(Refused::new(
      Code::TooLarge,
      format!("a trial's prompt holds at most {MOST_PROMPT_CHARS} characters"),
    ));
  }

  let runs = &app.stages.runs;
  let mut request = GateRequest::new(instructions_of(&gate_name)?, prompt.clone());

  request.agent = Some(runs.chat_agent.clone());

  let started = Instant::now();
  let answer = runs.run(&gate_name, &request).await.map_err(Refused::of_run)?;
  let row = web_gate_chats::ActiveModel {
    id: ActiveValue::NotSet,
    stage: ActiveValue::Set(gate_name),
    user_name: ActiveValue::Set(user_name),
    prompt: ActiveValue::Set(prompt),
    answer: ActiveValue::Set(answer),
    ms: ActiveValue::Set(started.elapsed().as_millis() as i64),
    created_at: ActiveValue::Set(now()),
    rowid: ActiveValue::NotSet,
    user_id: ActiveValue::Set(user_id),
  }
  .insert(&runs.db)
  .await
  .map_err(Refused::database)?;

  Ok((StatusCode::CREATED, Json(trial_of(row))))
}

pub async fn list(
  State(app): State<Arc<App>>,
  Query(asked): Query<TrialQuery>,
) -> Answered<Json<Page<Trial>>> {
  if let Some(gate_name) = &asked.gate_name {
    gate(gate_name)?;
  }

  let limit = page(asked.limit);
  let mut found = web_gate_chats::Entity::find();

  if let Some(gate_name) = &asked.gate_name {
    found = found.filter(web_gate_chats::Column::Stage.eq(gate_name));
  }
  if let Some(after) = asked.after {
    found = found.filter(web_gate_chats::Column::Id.gt(after));
  }
  if let Some(before) = asked.before {
    found = found.filter(web_gate_chats::Column::Id.lt(before));
  }

  let mut rows = found
    .order_by_asc(web_gate_chats::Column::Id)
    .limit(limit + 1)
    .all(&app.stages.runs.db)
    .await
    .map_err(Refused::database)?;
  let more = rows.len() as u64 > limit;

  rows.truncate(limit as usize);

  Ok(Json(Page::of(rows.into_iter().map(trial_of).collect(), more)))
}
