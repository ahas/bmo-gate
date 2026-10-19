//! For the console (`docs/boundary-api.md`, 「For the console」): the gate order with each gate's profile, a gate's
//! options read and changed, and Laya's health beside every probed gate's mode, agreement and checkpoint.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use gate_codes::Code;
use gate_policy::gates::GATE_ORDER;
use gate_policy::profiles::PROFILES;
use gate_runs::options::{self, LAYA_MODES, View};
use gate_runs::records::now;
use gate_stages::laya_agreement::{self, TAU_GRID};
use gate_stages::laya_health;
use serde::Serialize;
use serde_json::{Value, json};

use crate::App;
use crate::answer::{Answered, Body, Refused};

pub async fn gates() -> Json<Value> {
  let mut seen = HashSet::new();
  let gates: Vec<Value> = GATE_ORDER
    .standing()
    .into_iter()
    .filter(|one| seen.insert(one.key))
    .map(|one| {
      let profile = PROFILES.of(one.key);

      json!({
        "key": one.key,
        "part": one.part.as_str(),
        "step": one.step,
        "condition": one.condition,
        "switchable": profile.is_some_and(|profile| profile.switchable),
        "laya_probe": profile.is_some_and(|profile| profile.laya_probe()),
        "default_laya_mode": profile.and_then(|profile| profile.laya_mode.as_deref()),
        "answer_tokens": profile.and_then(|profile| profile.answer_tokens),
      })
    })
    .collect();

  Json(json!({ "gates": gates }))
}

pub async fn options(State(app): State<Arc<App>>, Path(key): Path<String>) -> Answered<Json<View>> {
  options::view(&app.stages.runs, &key).await.map(Json).map_err(Refused::of_options)
}

#[derive(Serialize)]
pub struct Changed {
  pub key: String,
  pub options: options::RouteView,
}

pub async fn change(
  State(app): State<Arc<App>>,
  Path(key): Path<String>,
  Body(body): Body<Value>,
) -> Answered<Json<Changed>> {
  let runs = &app.stages.runs;

  options::change(runs, &key, &body, now()).await.map_err(Refused::of_options)?;

  let options = options::route_view(runs, &key).await.map_err(Refused::of_options)?;

  Ok(Json(Changed { key, options }))
}

pub async fn laya(State(app): State<Arc<App>>) -> Answered<Json<Value>> {
  let runs = &app.stages.runs;
  let db = &runs.db;
  let health = laya_health::read(db).await.map_err(Refused::database)?;
  let folders = options::checkpoint_folders(health.model.as_deref().unwrap_or_default());
  let checkpoints: Vec<String> = folders.iter().map(|(gate, _)| gate.clone()).collect();
  let pairs = laya_agreement::read_pairs(db, None).await.map_err(Refused::database)?;
  let tallies = laya_agreement::read_question_tallies(db, &laya_agreement::settled_each(), None)
    .await
    .map_err(Refused::database)?;
  let agreements = laya_agreement::agreement(&pairs, &tallies);
  let mut gates = vec![];

  for key in GATE_ORDER.keys() {
    let Some(profile) = PROFILES.of(key).filter(|profile| profile.laya_probe()) else {
      continue;
    };
    let row = options::row(db, key, &runs.chat_agent)
      .await
      .map_err(Refused::database)?
      .unwrap_or_default();
    let refused: Vec<Value> = LAYA_MODES
      .iter()
      .filter_map(|mode| {
        options::mode_refused(profile, mode, &checkpoints)
          .map(|code| json!({ "mode": mode, "code": code.as_str() }))
      })
      .collect();

    gates.push(json!({
      "stage": key,
      "mode": options::effective_mode(profile, row.laya_mode.as_deref(), row.laya_tau),
      "tau": row.laya_tau,
      "agreement": agreements.iter().find(|one| one.stage == key),
      "checkpoint": folders.iter().find(|(gate, _)| gate == key).map(|(_, folder)| folder),
      "refused": refused,
    }));
  }

  Ok(Json(json!({
    "health": {
      "state": health.state,
      "model": health.model,
      "device": health.device,
      "vram_bytes": health.vram_bytes,
      "load_ms": health.load_ms,
      "versions": health.versions,
      "address": health.address,
      "check_ms": health.check_ms,
      "checked_at": health.checked_at,
      "answered_at": health.healthy_at,
    },
    "gates": gates,
    "modes": LAYA_MODES,
    "taus": TAU_GRID,
  })))
}

/// The gate a path names, refused `no_gate` where it is none of the gate order.
pub fn gate(stage: &str) -> Answered<()> {
  if options::is_gate(stage) {
    Ok(())
  } else {
    Err(Refused::new(Code::NoGate, format!("{stage} is no gate of the gate order")))
  }
}
