//! A gate's own options (`docs/boundary-api.md`, 「For the console」): its wait, which only its row sets, and its
//! switch where its profile lets it be switched off, kept for each agent. What a gate runs on beside them — its
//! thinking and answer room — is its tier's on its own road. The screen reads and writes the chat agent's rows; a
//! companion's are copied from them.

use gate_codes::Code;
use gate_policy::fill_marks;
use gate_policy::gates::GATE_ORDER;
use gate_policy::profiles::{PROFILES, Profile};
use gate_ports::agency::Mapping;
use gate_store::entity::gate_options;
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

/// Why a change was not taken: its code and the sentence naming why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
  pub code: Code,
  pub error: String,
}

impl Refusal {
  fn of(code: Code, error: impl Into<String>) -> Self {
    Self {
      code,
      error: error.into(),
    }
  }

  fn database(why: DbErr) -> Self {
    Self::of(Code::Failed, why.to_string())
  }

  fn unit(why: GateError) -> Self {
    Self::of(Code::UpstreamFailed, why.to_string())
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

/// What one gate's row holds for one agent.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GateRow {
  pub timeout_ms: Option<i64>,
  pub enabled: Option<bool>,
}

/// One gate's row for one agent, where one stands.
pub async fn row(db: &DatabaseConnection, key: &str, agent: &str) -> Result<Option<GateRow>, DbErr> {
  let found = gate_options::Entity::find_by_id((key.to_owned(), agent.to_owned())).one(db).await?;

  Ok(found.map(|row| GateRow {
    timeout_ms: row.timeout_ms,
    enabled: row.enabled.map(|enabled| enabled != 0),
  }))
}

/// How long the gate waits for one agent: its row's value, which nothing else sets; none where the row holds
/// none.
pub async fn timeout_ms(db: &DatabaseConnection, key: &str, agent: &str) -> Result<Option<i64>, DbErr> {
  Ok(row(db, key, agent).await?.and_then(|row| row.timeout_ms))
}

/// What a gate asks for where its tier says nothing.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
  pub thinking: bool,
  pub answer_tokens: i64,
}

pub fn defaults(profile: &Profile) -> Defaults {
  Defaults {
    thinking: false,
    answer_tokens: profile.answer_tokens.unwrap_or(DEFAULT_ANSWER_TOKENS),
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
/// its own row's wait.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
  pub thinking: bool,
  pub answer_tokens: i64,
  pub timeout_ms: Option<i64>,
}

/// One gate's options as the screen reads them: what the owner chose, field by field, what the gate runs on,
/// and the defaults a blank stands for.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
  pub timeout_ms: Option<i64>,
  pub switchable: bool,
  pub enabled: bool,
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
    switchable: profile.switchable,
    enabled: !profile.switchable || row.enabled != Some(false),
    effective: Effective {
      thinking,
      answer_tokens,
      timeout_ms: row.timeout_ms,
    },
    defaults: defaults(profile),
  })
}

/// A gate's route as a run reads it: the provider its road begins on, the model its tier maps there, its wait
/// and when its route was last set.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteView {
  pub provider: String,
  pub model: String,
  pub timeout_ms: Option<i64>,
  pub set_at: i64,
}

pub async fn route_view(runs: &Runs, key: &str) -> Result<RouteView, Refusal> {
  route_view_for(runs, key, &runs.chat_agent).await
}

/// A gate's route as a run reads it for one agent, its wait that agent's.
pub async fn route_view_for(runs: &Runs, key: &str, agent: &str) -> Result<RouteView, Refusal> {
  profile(key)?;

  let road = route::read(runs, key).await.map_err(Refusal::unit)?;
  let route = runs.agency.work_key(key).await.map_err(|why| Refusal::unit(fault(why)))?;
  let set_at = route.and_then(|one| one.set_at).unwrap_or(0);

  Ok(RouteView {
    provider: road.provider.clone(),
    model: road.model().to_owned(),
    timeout_ms: timeout_ms(&runs.db, key, agent).await.map_err(Refusal::database)?,
    set_at,
  })
}

/// Whether a gate is asked at all for an agent: one that may not be switched off always is, and one that may is
/// asked unless its row says off.
pub async fn switched_on(db: &DatabaseConnection, key: &str, agent: &str) -> Result<bool, DbErr> {
  let Some(profile) = PROFILES.of(key) else { return Ok(false) };

  Ok(!profile.switchable || row(db, key, agent).await?.and_then(|row| row.enabled) != Some(false))
}

/// A whole number a field holds, as JSON gives it.
fn whole(value: &Value) -> Option<i64> {
  value
    .as_i64()
    .or_else(|| value.as_f64().filter(|number| number.fract() == 0.0).map(|number| number as i64))
}

/// One gate's options for the chat agent, as `change_for` writes them.
pub async fn change(runs: &Runs, key: &str, body: &Value, at: i64) -> Result<(), Refusal> {
  change_for(runs, key, &runs.chat_agent, body, at).await
}

/// One gate's wait and switch for one agent, each written into that agent's row where it is sent and left as the
/// row had it otherwise; the wait is never cleared. No other agent's row is touched.
pub async fn change_for(runs: &Runs, key: &str, agent: &str, body: &Value, at: i64) -> Result<(), Refusal> {
  let profile = profile(key)?;
  let sent = |field: &str| body.get(field);

  if sent("thinking").is_some() || sent("answerTokens").is_some() {
    return Err(Refusal::of(Code::OwnLlm, words::OWN_LLM));
  }

  let [timeout, enabled] = ["timeoutMs", "enabled"].map(sent);

  if [timeout, enabled].iter().all(Option::is_none) {
    return Err(Refusal::of(Code::NothingToChange, words::NOTHING));
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

  let db = &runs.db;
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
      rowid: NotSet,
    },
  };

  changed.set_at = Set(at);

  if let Some(timeout) = timeout {
    changed.timeout_ms = Set(Some(timeout));
  }

  if let Some(enabled) = enabled.and_then(Value::as_bool) {
    changed.enabled = Set(Some(i64::from(enabled)));
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
      rowid: NotSet,
    }
    .insert(&written)
    .await?;
  }

  written.commit().await
}
