//! Gate runs (`docs/api.md`, 「Runs」): one run of one gate on its road, its instructions the gate's own where
//! the caller names none; a gate switched off answers nothing without asking any road.

use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::extract::{Path, State};
use bmo_gate_client::{StageRun, StageRunAsk};
use gate_runs::{GateRequest, options};

use crate::App;
use crate::answer::{Answered, Body, Refused};
use crate::routes::gates::{gate, instructions_of};

pub async fn run(
  State(app): State<Arc<App>>,
  Path(gate_name): Path<String>,
  Body(asked): Body<StageRunAsk>,
) -> Answered<Json<StageRun>> {
  gate(&gate_name)?;

  let runs = &app.stages.runs;
  let agent = asked.agent_name.clone().unwrap_or_else(|| runs.chat_agent.clone());
  let started = Instant::now();

  // A gate switched off is not asked.
  if !options::switched_on(&runs.db, &gate_name, &agent).await.map_err(Refused::database)? {
    return Ok(Json(StageRun {
      answer: None,
      ms: 0,
    }));
  }

  let system = match asked.system {
    Some(system) => system,
    None => instructions_of(&gate_name)?,
  };
  let mut request = GateRequest::new(system, asked.prompt);

  request.chat_id = asked.room_id;
  request.message_id = asked.message_id;
  request.agent = Some(agent);
  request.thinking = asked.thinking.unwrap_or(true);
  request.alongside = asked.alongside.unwrap_or(false);
  request.tenant = asked.tenant.filter(|tenant| !tenant.trim().is_empty());

  let answer = runs.run(&gate_name, &request).await.map_err(Refused::of_run)?;

  Ok(Json(StageRun {
    answer,
    ms: started.elapsed().as_millis() as i64,
  }))
}
