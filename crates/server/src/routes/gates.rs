//! Gates (`docs/api.md`, 「Gates」): the gate order with each gate's profile, and a gate's options read and
//! changed, a companion's copied.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use bmo_gate_client::{
  DefaultOptions, EffectiveOptions, Gate, GateOptions, GateOptionsChanged, GateRoute, OptionsCopied, Page,
};
use gate_codes::Code;
use gate_policy::gates::GATE_ORDER;
use gate_policy::profiles::PROFILES;
use gate_runs::options;
use gate_runs::records::now;
use serde_json::Value;

use crate::App;
use crate::answer::{Answered, Body, Refused};

pub async fn gates() -> Json<Page<Gate>> {
  let mut seen = HashSet::new();
  let gates: Vec<Gate> = GATE_ORDER
    .standing()
    .into_iter()
    .filter(|one| seen.insert(one.key))
    .map(|one| {
      let profile = PROFILES.of(one.key);

      Gate {
        gate_name: one.key.to_owned(),
        part: one.part.as_str().to_owned(),
        step: one.step as i64,
        condition: one.condition.map(str::to_owned),
        switchable: profile.is_some_and(|profile| profile.switchable),
        answer_tokens: profile.and_then(|profile| profile.answer_tokens),
      }
    })
    .collect();

  Json(Page::of(gates, false))
}

fn options_of(view: options::View) -> GateOptions {
  GateOptions {
    timeout_ms: view.timeout_ms,
    switchable: view.switchable,
    enabled: view.enabled,
    effective: EffectiveOptions {
      thinking: view.effective.thinking,
      answer_tokens: view.effective.answer_tokens,
      timeout_ms: view.effective.timeout_ms,
    },
    defaults: DefaultOptions {
      thinking: view.defaults.thinking,
      answer_tokens: view.defaults.answer_tokens,
    },
  }
}

fn route_of(route: options::RouteView) -> GateRoute {
  GateRoute {
    provider: route.provider,
    model: route.model,
    timeout_ms: route.timeout_ms,
    set_at: route.set_at,
  }
}

pub async fn options(
  State(app): State<Arc<App>>,
  Path(gate_name): Path<String>,
) -> Answered<Json<GateOptions>> {
  options::view(&app.stages.runs, &gate_name)
    .await
    .map(|view| Json(options_of(view)))
    .map_err(Refused::of_options)
}

pub async fn change(
  State(app): State<Arc<App>>,
  Path(gate_name): Path<String>,
  Body(change): Body<bmo_gate_client::GateOptionChange>,
) -> Answered<Json<GateOptionsChanged>> {
  let agent = app.stages.runs.chat_agent.clone();

  changed(&app, gate_name, &agent, &change).await
}

/// One gate's options changed for the agent the path names, and for no other.
pub async fn change_for(
  State(app): State<Arc<App>>,
  Path((gate_name, agent_name)): Path<(String, String)>,
  Body(change): Body<bmo_gate_client::GateOptionChange>,
) -> Answered<Json<GateOptionsChanged>> {
  changed(&app, gate_name, &agent_name, &change).await
}

async fn changed(
  app: &App,
  gate_name: String,
  agent: &str,
  change: &bmo_gate_client::GateOptionChange,
) -> Answered<Json<GateOptionsChanged>> {
  let runs = &app.stages.runs;
  let body = serde_json::to_value(change)
    .map_err(|why| Refused::new(Code::BadRequest, format!("the change could not be read: {why}")))?;

  options::change_for(runs, &gate_name, agent, &body, now())
    .await
    .map_err(Refused::of_options)?;

  let options = options::route_view_for(runs, &gate_name, agent).await.map_err(Refused::of_options)?;

  Ok(Json(GateOptionsChanged {
    gate_name,
    options: route_of(options),
  }))
}

pub async fn copy(
  State(app): State<Arc<App>>,
  Body(copied): Body<OptionsCopied>,
) -> Answered<axum::http::StatusCode> {
  options::copy(&app.stages.runs.db, &copied.agent_name, &copied.from_agent_name, now())
    .await
    .map_err(Refused::database)?;

  Ok(axum::http::StatusCode::NO_CONTENT)
}

/// The gate a path names, refused `no-gate` where it is none of the gate order.
pub fn gate(name: &str) -> Answered<()> {
  if options::is_gate(name) {
    Ok(())
  } else {
    Err(Refused::new(Code::NoGate, format!("{name} is no gate of the gate order")))
  }
}

/// The gate's own instructions, as a run of it is handed them where its caller names none. No gate stands in
/// the order, so none carries instructions.
pub fn instructions_of(gate_name: &str) -> Answered<String> {
  Err(Refused::failed(format!("{gate_name}: its instructions are not among the prompts")))
}

/// A value as JSON for the wire.
pub fn json_of<T: serde::Serialize>(value: &T) -> Answered<Value> {
  serde_json::to_value(value)
    .map_err(|why| Refused::failed(format!("the answer could not be written: {why}")))
}
