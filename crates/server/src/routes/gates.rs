//! Gates (`docs/api.md`, 「Gates」 and 「Laya」): the gate order with each gate's profile, a gate's options read
//! and changed, a companion's copied, and Laya's health beside every probed gate's mode, agreement and
//! checkpoint.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use bmo_gate_client::{
  Agreement, AgreementAt, DefaultOptions, EffectiveOptions, Gate, GateOptions, GateOptionsChanged,
  GateRoute, LayaGate, LayaHealth, LayaView, ModeRefusal, OptionsCopied, Page,
};
use gate_codes::Code;
use gate_policy::gates::GATE_ORDER;
use gate_policy::profiles::PROFILES;
use gate_runs::options::{self, LAYA_MODES};
use gate_runs::records::now;
use gate_stages::laya_agreement::{self, TAU_GRID};
use gate_stages::laya_health;
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
        laya_probe: profile.is_some_and(|profile| profile.laya_probe()),
        default_laya_mode: profile.and_then(|profile| profile.laya_mode.clone()),
        answer_tokens: profile.and_then(|profile| profile.answer_tokens),
      }
    })
    .collect();

  Json(Page::of(gates, false))
}

fn options_of(view: options::View) -> GateOptions {
  GateOptions {
    timeout_ms: view.timeout_ms,
    laya_mode: view.laya_mode,
    laya_tau: view.laya_tau,
    laya_probe: view.laya_probe,
    switchable: view.switchable,
    enabled: view.enabled,
    laya_fallback: view.laya_fallback,
    effective: EffectiveOptions {
      thinking: view.effective.thinking,
      answer_tokens: view.effective.answer_tokens,
      timeout_ms: view.effective.timeout_ms,
      laya_mode: view.effective.laya_mode,
      laya_tau: view.effective.laya_tau,
    },
    defaults: DefaultOptions {
      thinking: view.defaults.thinking,
      answer_tokens: view.defaults.answer_tokens,
      laya_mode: view.defaults.laya_mode,
      laya_tau: view.defaults.laya_tau,
    },
  }
}

fn route_of(route: options::RouteView) -> GateRoute {
  GateRoute {
    provider: route.provider,
    model: route.model,
    laya: route.laya,
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
  let runs = &app.stages.runs;
  let body = serde_json::to_value(&change)
    .map_err(|why| Refused::new(Code::BadRequest, format!("the change could not be read: {why}")))?;

  options::change(runs, &gate_name, &body, now()).await.map_err(Refused::of_options)?;

  let options = options::route_view(runs, &gate_name).await.map_err(Refused::of_options)?;

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

fn agreement_of(agreement: &laya_agreement::Agreement) -> Agreement {
  Agreement {
    gate_name: agreement.stage.clone(),
    unit: match agreement.unit {
      laya_agreement::Unit::Pair => "pair".to_owned(),
      laya_agreement::Unit::Question => "question".to_owned(),
    },
    pairs: agreement.pairs as i64,
    failures: agreement.failures as i64,
    agreement: agreement.agreement,
    by_tau: agreement
      .by_tau
      .iter()
      .map(|at| AgreementAt {
        tau: at.tau,
        coverage: at.coverage,
        agreement: at.agreement,
        safe_count: at.safe_count.map(|count| count as i64),
        safe_agreement: at.safe_agreement,
      })
      .collect(),
    settled: agreement.settled,
  }
}

pub async fn laya(State(app): State<Arc<App>>) -> Answered<Json<LayaView>> {
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
    let refused: Vec<ModeRefusal> = LAYA_MODES
      .iter()
      .filter_map(|mode| {
        options::mode_refused(profile, mode, &checkpoints).map(|code| ModeRefusal {
          mode: (*mode).to_owned(),
          code: code.as_str().to_owned(),
        })
      })
      .collect();

    gates.push(LayaGate {
      gate_name: key.to_owned(),
      mode: options::effective_mode(profile, row.laya_mode.as_deref(), row.laya_tau),
      tau: row.laya_tau,
      agreement: agreements.iter().find(|one| one.stage == key).map(agreement_of),
      checkpoint: folders.iter().find(|(gate, _)| gate == key).map(|(_, folder)| folder.clone()),
      refused,
    });
  }

  Ok(Json(LayaView {
    health: LayaHealth {
      state: health.state,
      model: health.model,
      device: health.device,
      vram_bytes: health.vram_bytes,
      load_ms: health.load_ms,
      versions: health.versions,
      address: health.address,
      check_ms: health.check_ms,
      checked_at: health.checked_at,
      answered_at: health.healthy_at,
    },
    gates,
    modes: LAYA_MODES.iter().map(|mode| (*mode).to_owned()).collect(),
    taus: TAU_GRID.to_vec(),
  }))
}

/// The gate a path names, refused `no-gate` where it is none of the gate order.
pub fn gate(name: &str) -> Answered<()> {
  if options::is_gate(name) {
    Ok(())
  } else {
    Err(Refused::new(Code::NoGate, format!("{name} is no gate of the gate order")))
  }
}

/// The gate's own instructions, as a run of it is handed them where its caller names none.
pub fn instructions_of(gate_name: &str) -> Answered<String> {
  gate_policy::prompts::instructions(gate_name)
    .map(str::to_owned)
    .ok_or_else(|| Refused::failed(format!("{gate_name}: its instructions are not among the prompts")))
}

/// A value as JSON for the wire.
pub fn json_of<T: serde::Serialize>(value: &T) -> Answered<Value> {
  serde_json::to_value(value)
    .map_err(|why| Refused::failed(format!("the answer could not be written: {why}")))
}
