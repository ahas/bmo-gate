//! For the voice unit (`docs/boundary-api.md`, 「For the voice unit: the voice gates」): one run of one gate, on the
//! stage's road with its options, its instructions the stage's own where the caller names none; a stage switched
//! off answers nothing without asking any road.

use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::extract::{Path, State};
use gate_policy::prompts;
use gate_runs::{GateRequest, options};
use serde::{Deserialize, Serialize};

use crate::App;
use crate::answer::{Answered, Body, Refused};
use crate::routes::console::gate;

/// A gate's own instructions, as a run of it is handed them where its caller names none.
pub fn instructions_of(stage: &str) -> Answered<String> {
  prompts::instructions(stage)
    .map(str::to_owned)
    .ok_or_else(|| Refused::failed(format!("{stage}: its instructions are not among the prompts")))
}

#[derive(Deserialize)]
pub struct Asked {
  pub prompt: String,
  #[serde(default)]
  pub system: Option<String>,
  #[serde(default)]
  pub chat: Option<i64>,
  #[serde(default)]
  pub message: Option<i64>,
  #[serde(default)]
  pub agent: Option<String>,
  #[serde(default)]
  pub thinking: Option<bool>,
  #[serde(default)]
  pub alongside: Option<bool>,
}

#[derive(Serialize)]
pub struct Ran {
  pub answer: Option<String>,
  pub ms: i64,
}

pub async fn run(
  State(app): State<Arc<App>>,
  Path(stage): Path<String>,
  Body(asked): Body<Asked>,
) -> Answered<Json<Ran>> {
  gate(&stage)?;

  let runs = &app.stages.runs;
  let agent = asked.agent.clone().unwrap_or_else(|| runs.chat_agent.clone());
  let started = Instant::now();

  if !options::switched_on(&runs.db, &stage, &agent).await.map_err(Refused::database)? {
    return Ok(Json(Ran {
      answer: None,
      ms: 0,
    }));
  }

  let system = match asked.system {
    Some(system) => system,
    None => instructions_of(&stage)?,
  };
  let mut request = GateRequest::new(system, asked.prompt);

  request.chat_id = asked.chat;
  request.message_id = asked.message;
  request.agent = Some(agent);
  request.thinking = asked.thinking.unwrap_or(true);
  request.alongside = asked.alongside.unwrap_or(false);

  let answer = runs.run(&stage, &request).await.map_err(Refused::of_run)?;

  Ok(Json(Ran {
    answer,
    ms: started.elapsed().as_millis() as i64,
  }))
}
