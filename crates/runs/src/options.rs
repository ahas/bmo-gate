//! A gate's own options (`docs/boundary-api.md`, 「For the console」; `docs/laya.md`, 「Mode and τ per gate」): its
//! wait, which only its row sets, its Laya mode, τ and fallback LLM, and its switch where its profile lets it be
//! switched off, kept for each agent. What a gate runs on beside them — its thinking and answer room — is its
//! tier's on its own road. The screen reads and writes the chat agent's rows; a companion's are copied from them.

use gate_codes::Code;
use gate_policy::fill_marks;
use gate_policy::gates::GATE_ORDER;
use gate_policy::profiles::{PROFILES, Profile};
use gate_ports::agency::Mapping;
use gate_store::entity::{gate_options, laya_health};
use gate_words::options as words;
use sea_orm::{
  ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, NotSet,
  QueryFilter, TransactionTrait,
};
use serde::Serialize;
use serde_json::Value;

use crate::route;
use crate::{GateError, Runs, fault};

/// What a gate's answer is given where neither its tier nor its own work asks for more.
pub const DEFAULT_ANSWER_TOKENS: i64 = 2048;

/// The narrowest and widest wait worth storing.
pub const TIMEOUT_MIN_MS: i64 = 1_000;
pub const TIMEOUT_MAX_MS: i64 = 300_000;

/// Every Laya mode a gate may stand in.
pub const LAYA_MODES: [&str; 4] = ["off", "shadow", "filter", "asymmetric"];

/// What a gate's fallback setting says where it asks no LLM at all.
pub const NO_LAYA_FALLBACK: &str = "none";

/// Why a change was not taken: its code, the code of the mode refusal beside it where it is one, and the
/// sentence naming why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
  pub code: Code,
  pub reason: Option<Code>,
  pub error: String,
}

impl Refusal {
  fn of(code: Code, error: impl Into<String>) -> Self {
    Self {
      code,
      reason: None,
      error: error.into(),
    }
  }

  fn mode(reason: Code, error: impl Into<String>) -> Self {
    Self {
      code: Code::LayaModeRefused,
      reason: Some(reason),
      error: error.into(),
    }
  }

  fn database(why: DbErr) -> Self {
    Self::of(Code::Database, why.to_string())
  }

  fn unit(why: GateError) -> Self {
    Self::of(Code::UnitFailed, why.to_string())
  }
}

/// Whether a key is a gate of the gate order.
pub fn is_gate(key: &str) -> bool {
  GATE_ORDER.holds(key)
}

fn profile(key: &str) -> Result<&'static Profile, Refusal> {
  PROFILES
    .of(key)
    .ok_or_else(|| Refusal::of(Code::NoGate, fill_marks(words::NOT_GATE, &[("key", key)])))
}

/// What one gate's row holds for one agent. A Laya mode the row holds that is no mode reads as none.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GateRow {
  pub timeout_ms: Option<i64>,
  pub laya_mode: Option<String>,
  pub laya_tau: Option<f64>,
  pub enabled: Option<bool>,
  pub laya_fallback: Option<String>,
}

/// One gate's row for one agent, where one stands.
pub async fn row(db: &DatabaseConnection, key: &str, agent: &str) -> Result<Option<GateRow>, DbErr> {
  let found = gate_options::Entity::find_by_id((key.to_owned(), agent.to_owned())).one(db).await?;

  Ok(found.map(|row| GateRow {
    timeout_ms: row.timeout_ms,
    laya_mode: row.laya_mode.filter(|mode| LAYA_MODES.contains(&mode.as_str())),
    laya_tau: row.laya_tau,
    enabled: row.enabled.map(|enabled| enabled != 0),
    laya_fallback: row.laya_fallback,
  }))
}

/// How long the gate waits for one agent: its row's value, which nothing else sets; none where the row holds
/// none.
pub async fn timeout_ms(db: &DatabaseConnection, key: &str, agent: &str) -> Result<Option<i64>, DbErr> {
  Ok(row(db, key, agent).await?.and_then(|row| row.timeout_ms))
}

/// Whether Laya's verdict may stand in a mode, which then needs a τ to stand on.
pub fn decides(mode: &str) -> bool {
  mode == "filter" || mode == "asymmetric"
}

/// The mode a gate actually runs in: off without a probe, and shadow where its row would let Laya decide with no
/// τ, or asymmetric for a gate with no safe verdict.
pub fn effective_mode(profile: &Profile, chosen: Option<&str>, tau: Option<f64>) -> String {
  let Some(default) = profile.laya_mode.as_deref() else {
    return "off".into();
  };
  let mode = chosen.unwrap_or(default);

  if (mode == "asymmetric" && !profile.laya_safe) || (decides(mode) && tau.is_none()) {
    return "shadow".into();
  }

  mode.into()
}

/// What a gate asks for where its tier says nothing and its row names no Laya mode.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Defaults {
  pub thinking: bool,
  pub answer_tokens: i64,
  pub laya_mode: String,
  pub laya_tau: Option<f64>,
}

pub fn defaults(profile: &Profile) -> Defaults {
  Defaults {
    thinking: false,
    answer_tokens: profile.answer_tokens.unwrap_or(DEFAULT_ANSWER_TOKENS),
    laya_mode: profile.laya_mode.clone().unwrap_or_else(|| "off".into()),
    laya_tau: None,
  }
}

/// Whether a registered model's mapping thinks: its effort says so.
pub fn thinks_on(mapping: &Mapping) -> bool {
  mapping.effort.as_deref() == Some("thinking")
}

/// The answer room a gate's request on a registered model is given: its tier's there, never below the gate's
/// own floor, and the common default where neither names one.
pub fn answer_room(stage: &str, mapping: Option<&Mapping>) -> i64 {
  let floor = PROFILES.of(stage).and_then(|profile| profile.answer_tokens);

  mapping
    .and_then(|mapping| mapping.answer_tokens)
    .or(floor)
    .unwrap_or(DEFAULT_ANSWER_TOKENS)
    .max(floor.unwrap_or(0))
}

/// What a gate actually runs on: on a registered model what it asks that road for, the defaults otherwise; and
/// its own row's wait, Laya mode and τ.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Effective {
  pub thinking: bool,
  pub answer_tokens: i64,
  pub timeout_ms: Option<i64>,
  pub laya_mode: String,
  pub laya_tau: Option<f64>,
}

/// One gate's options as the screen reads them: what the owner chose, field by field, what the gate runs on,
/// and the defaults a blank stands for.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct View {
  pub timeout_ms: Option<i64>,
  pub laya_mode: Option<String>,
  pub laya_tau: Option<f64>,
  pub laya_probe: bool,
  pub switchable: bool,
  pub enabled: bool,
  pub laya_fallback: Option<String>,
  pub effective: Effective,
  pub defaults: Defaults,
}

/// The chat agent's options of one gate, as the screen reads them.
pub async fn view(runs: &Runs, key: &str) -> Result<View, Refusal> {
  let profile = profile(key)?;
  let row = row(&runs.db, key, &runs.chat_agent)
    .await
    .map_err(Refusal::database)?
    .unwrap_or_default();
  let road = route::read(runs, key).await.map_err(Refusal::unit)?;
  let (thinking, answer_tokens) = match (&road.way, &road.mapping) {
    (route::Way::Gateway, Some(mapping)) => (thinks_on(mapping), answer_room(key, Some(mapping))),
    _ => (false, profile.answer_tokens.unwrap_or(DEFAULT_ANSWER_TOKENS)),
  };

  Ok(View {
    timeout_ms: row.timeout_ms,
    laya_mode: row.laya_mode.clone(),
    laya_tau: row.laya_tau,
    laya_probe: profile.laya_probe(),
    switchable: profile.switchable,
    enabled: !profile.switchable || row.enabled != Some(false),
    laya_fallback: row.laya_fallback.clone(),
    effective: Effective {
      thinking,
      answer_tokens,
      timeout_ms: row.timeout_ms,
      laya_mode: effective_mode(profile, row.laya_mode.as_deref(), row.laya_tau),
      laya_tau: row.laya_tau,
    },
    defaults: defaults(profile),
  })
}

/// A gate's route as a run reads it: the provider its road begins on, the model its tier maps there, whether it
/// stands on Laya, its wait and when its route was last set.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RouteView {
  pub provider: String,
  pub model: String,
  pub laya: bool,
  pub timeout_ms: Option<i64>,
  pub set_at: i64,
}

pub async fn route_view(runs: &Runs, key: &str) -> Result<RouteView, Refusal> {
  profile(key)?;

  let road = route::read(runs, key).await.map_err(Refusal::unit)?;
  let routes = runs.agency.routes().await.map_err(|why| Refusal::unit(fault(why)))?;
  let set_at = routes.iter().find(|one| one.key == key).and_then(|one| one.set_at).unwrap_or(0);

  Ok(RouteView {
    provider: road.provider.clone(),
    model: road.model().to_owned(),
    laya: road.laya,
    timeout_ms: timeout_ms(&runs.db, key, &runs.chat_agent).await.map_err(Refusal::database)?,
    set_at,
  })
}

/// Whether a gate is asked at all for an agent: one that may not be switched off always is, and one that may is
/// asked unless its row says off.
pub async fn switched_on(db: &DatabaseConnection, key: &str, agent: &str) -> Result<bool, DbErr> {
  let Some(profile) = PROFILES.of(key) else { return Ok(false) };

  Ok(!profile.switchable || row(db, key, agent).await?.and_then(|row| row.enabled) != Some(false))
}

/// The provider a gate on Laya asks where Laya gives no verdict, as the chat agent's row says (`docs/laya.md`, 「A
/// gate whose provider is Laya」): the one its road would begin on where the row names none, the one it names
/// where that is on, and none where it says `none` or names one switched off.
pub async fn laya_fallback(runs: &Runs, stage: &str) -> Result<Option<String>, GateError> {
  let named = row(&runs.db, stage, &runs.chat_agent)
    .await
    .map_err(fault)?
    .and_then(|row| row.laya_fallback);
  let providers = runs.agency.providers().await.map_err(fault)?;

  match named {
    Some(named) if named == NO_LAYA_FALLBACK => Ok(None),
    Some(named) => Ok(providers.iter().any(|one| one.name == named && one.enabled).then_some(named)),
    None => {
      let tier = route::tier_of(stage)?;
      let (provider, _) = route::road_provider(runs, stage, route::AUTO, &providers, &tier).await?;

      Ok(Some(provider))
    }
  }
}

/// The gates the last health check of the Laya server named a checkpoint for: its model line, each gate and its
/// folder joined by `=`, a comma between them.
pub async fn checkpoints(db: &DatabaseConnection) -> Result<Vec<String>, DbErr> {
  let model = laya_health::Entity::find().one(db).await?.and_then(|row| row.model).unwrap_or_default();

  Ok(
    model
      .split(',')
      .filter_map(|pair| {
        let (gate, folder) = pair.split_once('=')?;
        let (gate, folder) = (gate.trim(), folder.trim());

        (!gate.is_empty() && !folder.is_empty()).then(|| gate.to_owned())
      })
      .collect(),
  )
}

/// A whole number a field holds, as JSON gives it.
fn whole(value: &Value) -> Option<i64> {
  value
    .as_i64()
    .or_else(|| value.as_f64().filter(|number| number.fract() == 0.0).map(|number| number as i64))
}

/// One gate's wait, switch, Laya mode, τ and fallback LLM for the chat agent, each written where it is sent and
/// left as the row had it otherwise; a Laya field sent as null goes back to the profile's default, and the wait
/// is never cleared. A mode is taken only where the gate can run in it.
pub async fn change(runs: &Runs, key: &str, body: &Value, at: i64) -> Result<(), Refusal> {
  let profile = profile(key)?;
  let sent = |field: &str| body.get(field);

  if sent("thinking").is_some() || sent("answer_tokens").is_some() {
    return Err(Refusal::of(Code::OwnLlm, words::OWN_LLM));
  }

  let [timeout, mode, tau, enabled, fallback] =
    ["timeout_ms", "laya_mode", "laya_tau", "enabled", "laya_fallback"].map(sent);

  if [timeout, mode, tau, enabled, fallback].iter().all(Option::is_none) {
    return Err(Refusal::of(Code::NothingToChange, words::NOTHING));
  }

  if let Some(fallback) = fallback.filter(|fallback| !fallback.is_null()) {
    let providers = runs.agency.providers().await.map_err(|why| Refusal::unit(fault(why)))?;
    let known = fallback
      .as_str()
      .is_some_and(|name| name == NO_LAYA_FALLBACK || providers.iter().any(|one| one.name == name));

    if !known {
      return Err(Refusal::of(
        Code::LayaFallbackUnknown,
        fill_marks(words::FALLBACK, &[("fallback", NO_LAYA_FALLBACK)]),
      ));
    }
  }

  if let Some(enabled) = enabled {
    if !enabled.is_boolean() {
      return Err(Refusal::of(Code::SwitchNotBoolean, words::SWITCH));
    }

    if !profile.switchable {
      return Err(Refusal::of(Code::AlwaysOn, fill_marks(words::ALWAYS_ON, &[("key", key)])));
    }
  }

  let timeout = match timeout {
    None => None,
    Some(value) => Some(
      whole(value)
        .filter(|ms| (TIMEOUT_MIN_MS..=TIMEOUT_MAX_MS).contains(ms))
        .ok_or_else(|| {
          Refusal::of(
            Code::TimeoutOutOfRange,
            fill_marks(
              words::TIMEOUT,
              &[
                ("least", &(TIMEOUT_MIN_MS / 1000).to_string()),
                ("most", &(TIMEOUT_MAX_MS / 1000).to_string()),
              ],
            ),
          )
        })?,
    ),
  };

  if let Some(mode) = mode
    && !mode.is_null()
    && !mode.as_str().is_some_and(|mode| LAYA_MODES.contains(&mode))
  {
    return Err(Refusal::of(
      Code::LayaModeUnknown,
      fill_marks(words::MODE, &[("modes", &LAYA_MODES.join(", "))]),
    ));
  }

  if let Some(tau) = tau
    && !tau.is_null()
    && !tau.as_f64().is_some_and(|tau| tau.is_finite() && (0.0..=1.0).contains(&tau))
  {
    return Err(Refusal::of(Code::LayaTauOutOfRange, words::TAU));
  }

  // What the row would say once written.
  let db = &runs.db;
  let agent = runs.chat_agent.as_str();
  let current = row(db, key, agent).await.map_err(Refusal::database)?.unwrap_or_default();
  let chosen_mode = match mode {
    None => current.laya_mode.clone(),
    Some(mode) => mode.as_str().map(str::to_owned),
  };
  let chosen_tau = match tau {
    None => current.laya_tau,
    Some(tau) => tau.as_f64(),
  };
  let resulting = chosen_mode
    .clone()
    .unwrap_or_else(|| profile.laya_mode.clone().unwrap_or_else(|| "off".into()));

  // A mode chosen now is taken only where the gate can run in it.
  if mode.is_some() && resulting != "off" {
    if !profile.laya_probe() {
      return Err(Refusal::mode(Code::NoProbe, fill_marks(words::NO_QUESTION, &[("key", key)])));
    }

    if resulting == "asymmetric" && !profile.laya_safe {
      return Err(Refusal::mode(Code::NoSafeVerdict, fill_marks(words::NO_SAFETY, &[("key", key)])));
    }

    if decides(&resulting)
      && !checkpoints(db).await.map_err(Refusal::database)?.iter().any(|gate| gate == key)
    {
      return Err(Refusal::mode(
        Code::NoCheckpoint,
        fill_marks(words::NO_CHECKPOINT, &[("mode", &resulting), ("key", key)]),
      ));
    }
  }

  if decides(&resulting) && chosen_tau.is_none() {
    return Err(Refusal::mode(Code::NeedsTau, fill_marks(words::NEEDS_TAU, &[("mode", &resulting)])));
  }

  let written = db.begin().await.map_err(Refusal::database)?;
  let existing = gate_options::Entity::find_by_id((key.to_owned(), agent.to_owned()))
    .one(&written)
    .await
    .map_err(Refusal::database)?;
  let fresh = existing.is_none();
  let mut changed: gate_options::ActiveModel = match existing {
    Some(existing) => existing.into(),
    None => gate_options::ActiveModel {
      key: Set(key.to_owned()),
      agent: Set(agent.to_owned()),
      thinking: Set(None),
      answer_tokens: Set(None),
      timeout_ms: Set(None),
      set_at: Set(at),
      enabled: Set(None),
      laya_mode: Set(None),
      laya_tau: Set(None),
      laya_fallback: Set(None),
      rowid: NotSet,
    },
  };

  changed.set_at = Set(at);

  if let Some(timeout) = timeout {
    changed.timeout_ms = Set(Some(timeout));
  }

  if mode.is_some() {
    changed.laya_mode = Set(chosen_mode);
  }

  if tau.is_some() {
    changed.laya_tau = Set(chosen_tau);
  }

  if let Some(enabled) = enabled.and_then(Value::as_bool) {
    changed.enabled = Set(Some(i64::from(enabled)));
  }

  if let Some(fallback) = fallback {
    changed.laya_fallback = Set(fallback.as_str().map(str::to_owned));
  }

  if fresh {
    changed.insert(&written).await.map_err(Refusal::database)?;
  } else {
    changed.update(&written).await.map_err(Refusal::database)?;
  }

  written.commit().await.map_err(Refusal::database)
}

/// A companion's gate options made from another agent's, every row copied as it stands under the companion's
/// name in place of any it held; an agent with no rows copies nothing.
pub async fn copy(db: &DatabaseConnection, agent: &str, from: &str, at: i64) -> Result<(), DbErr> {
  let rows = gate_options::Entity::find()
    .filter(gate_options::Column::Agent.eq(from))
    .all(db)
    .await?;

  if rows.is_empty() {
    return Ok(());
  }

  let written = db.begin().await?;

  gate_options::Entity::delete_many()
    .filter(gate_options::Column::Agent.eq(agent))
    .exec(&written)
    .await?;

  for row in rows {
    gate_options::ActiveModel {
      key: Set(row.key),
      agent: Set(agent.to_owned()),
      thinking: Set(row.thinking),
      answer_tokens: Set(row.answer_tokens),
      timeout_ms: Set(row.timeout_ms),
      set_at: Set(at),
      enabled: Set(row.enabled),
      laya_mode: Set(row.laya_mode),
      laya_tau: Set(row.laya_tau),
      laya_fallback: Set(row.laya_fallback),
      rowid: NotSet,
    }
    .insert(&written)
    .await?;
  }

  written.commit().await
}
