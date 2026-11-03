//! A gate's own options (`docs/api.md`, 「Gates」): its switch where its profile lets it be switched off, kept for
//! each agent. What a gate runs on beside it — its thinking and answer room — is its role's on its own road. The
//! screen reads and writes the chat agent's rows; a companion's are copied from them.

use gate_codes::Code;
use gate_policy::fill_marks;
use gate_policy::gates::GATE_ORDER;
use gate_policy::profiles::{PROFILES, Profile};
use gate_ports::agency::Entry;
use gate_store::entity::gate_options;
use gate_words::options as words;
use sea_orm::{
  ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, NotSet,
  QueryFilter, TransactionTrait,
};
use serde::Serialize;
use serde_json::Value;

use crate::route;
use crate::{GateError, Runs};

/// What a gate's answer is given where neither its role nor its own work asks for more.
pub const DEFAULT_ANSWER_TOKENS: i64 = 2048;

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
  pub enabled: Option<bool>,
}

/// One gate's row for one agent, where one stands.
pub async fn row(db: &DatabaseConnection, key: &str, agent: &str) -> Result<Option<GateRow>, DbErr> {
  let found = gate_options::Entity::find_by_id((key.to_owned(), agent.to_owned())).one(db).await?;

  Ok(found.map(|row| GateRow {
    enabled: row.enabled.map(|enabled| enabled != 0),
  }))
}

/// What a gate asks for where its role says nothing.
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

/// Whether a run on a registered model thinks: its role's entry there switches thinking on.
pub fn thinks_on(mapping: &Entry) -> bool {
  mapping.thinking.as_deref() == Some("on")
}

/// The answer room a gate's request on a registered model is given: the answer ceiling its role's entry names
/// there, never below the gate's own floor, and the common default where neither names one.
pub fn answer_room(stage: &str, mapping: Option<&Entry>) -> i64 {
  let floor = PROFILES.of(stage).and_then(|profile| profile.answer_tokens);

  mapping
    .and_then(|mapping| mapping.answer_tokens)
    .or(floor)
    .unwrap_or(DEFAULT_ANSWER_TOKENS)
    .max(floor.unwrap_or(0))
}

/// What a gate actually runs on: on a registered model what it asks that road for, the defaults otherwise.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
  pub thinking: bool,
  pub answer_tokens: i64,
}

/// One gate's options as the screen reads them: what the owner chose, field by field, what the gate runs on,
/// and the defaults a blank stands for.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
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
    switchable: profile.switchable,
    enabled: !profile.switchable || row.enabled != Some(false),
    effective: Effective {
      thinking,
      answer_tokens,
    },
    defaults: defaults(profile),
  })
}

/// A gate's road as a run reads it after a change of its options: the provider it goes out on, the model its
/// role's order names there, and the moment the change was written.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteView {
  pub provider: String,
  pub model: String,
  pub set_at: i64,
}

pub async fn route_view(runs: &Runs, key: &str, set_at: i64) -> Result<RouteView, Refusal> {
  profile(key)?;

  let road = route::read(runs, key).await.map_err(Refusal::unit)?;

  Ok(RouteView {
    provider: road.provider.clone(),
    model: road.model().to_owned(),
    set_at,
  })
}

/// Whether a gate is asked at all for an agent: one that may not be switched off always is, and one that may is
/// asked unless its row says off.
pub async fn switched_on(db: &DatabaseConnection, key: &str, agent: &str) -> Result<bool, DbErr> {
  let Some(profile) = PROFILES.of(key) else { return Ok(false) };

  Ok(!profile.switchable || row(db, key, agent).await?.and_then(|row| row.enabled) != Some(false))
}

/// One gate's options for the chat agent, as `change_for` writes them.
pub async fn change(runs: &Runs, key: &str, body: &Value, at: i64) -> Result<(), Refusal> {
  change_for(runs, key, &runs.chat_agent, body, at).await
}

/// One gate's switch for one agent, written into that agent's row where it is sent. No other agent's row is
/// touched.
pub async fn change_for(runs: &Runs, key: &str, agent: &str, body: &Value, at: i64) -> Result<(), Refusal> {
  let profile = profile(key)?;
  let sent = |field: &str| body.get(field);

  if sent("thinking").is_some() || sent("answerTokens").is_some() {
    return Err(Refusal::of(Code::OwnLlm, words::OWN_LLM));
  }

  let Some(enabled) = sent("enabled") else {
    return Err(Refusal::of(Code::NothingToChange, words::NOTHING));
  };
  let Some(enabled) = enabled.as_bool() else {
    return Err(Refusal::of(Code::SwitchNotBoolean, words::SWITCH));
  };

  if !profile.switchable {
    return Err(Refusal::of(Code::AlwaysOn, fill_marks(words::ALWAYS_ON, &[("key", key)])));
  }

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
      set_at: Set(at),
      enabled: Set(None),
      rowid: NotSet,
    },
  };

  changed.set_at = Set(at);
  changed.enabled = Set(Some(i64::from(enabled)));

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
      set_at: Set(at),
      enabled: Set(row.enabled),
      rowid: NotSet,
    }
    .insert(&written)
    .await?;
  }

  written.commit().await
}
