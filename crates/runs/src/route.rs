//! A gate's one road as its run reads it (`docs/gates.md`, 「Where a gate's runs go out」): the provider order of
//! the role its profile names, the provider the run goes out on there and the entry the order names for it, and
//! whether the provider's program carries the run or the gateway does.

use gate_policy::profiles::PROFILES;
use gate_ports::agency::{Entry, Provider, Role};

use crate::{GateError, Runs, fault};

/// How a run reaches its model: as a thrown-away session of the provider's program, or as one request through
/// the gateway for a provider whose models are registrations.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Way {
  Session,
  Gateway,
}

/// A gate's road as one run reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct Route {
  /// The gate the run is of.
  pub gate: String,
  /// The provider the road goes out on.
  pub provider: String,
  pub way: Way,
  /// The role whose provider order the road was read from.
  pub role: String,
  /// The entry the role's order names on the provider; none where the provider serves the gate nothing now.
  pub mapping: Option<Entry>,
}

impl Route {
  /// The model the road goes out on, as its entry names it; empty where it names none.
  pub fn model(&self) -> &str {
    self.mapping.as_ref().map(|mapping| mapping.model.as_str()).unwrap_or_default()
  }
}

/// The role a gate's profile names, whose provider order every run of it goes out on.
pub fn role_of(stage: &str) -> Result<String, GateError> {
  PROFILES
    .of(stage)
    .map(|profile| profile.role.clone())
    .ok_or_else(|| fault(format!("{stage} is no gate of the gate order")))
}

fn way_of(providers: &[Provider], provider: &str) -> Way {
  match providers.iter().find(|one| one.name == provider) {
    Some(one) if one.gateway || one.registered => Way::Gateway,
    _ => Way::Session,
  }
}

fn enabled(providers: &[Provider], name: &str) -> bool {
  providers.iter().any(|one| one.name == name && one.enabled)
}

/// The role the gate's profile names, as the agency holds it now.
async fn read_role(runs: &Runs, stage: &str) -> Result<Role, GateError> {
  let name = role_of(stage)?;

  runs
    .agency
    .role(&name)
    .await
    .map_err(fault)?
    .ok_or_else(|| fault(format!("{stage}: the agency holds no role {name}")))
}

/// The entry a role's order names on a provider that is on; none where the order holds none for it or it is off.
fn entry_on(role: &Role, providers: &[Provider], provider: &str) -> Option<Entry> {
  enabled(providers, provider)
    .then(|| role.order.iter().find(|entry| entry.provider == provider).cloned())
    .flatten()
}

/// The provider a gate's road goes out on, with the entry its role's order names there: the role's active
/// provider, else the first of its order that is on, else the order's first with nothing to run on. A role
/// whose order is empty follows a supervisor, and no supervisor asks a gate run, so it gives no road.
pub fn road_provider(
  stage: &str,
  role: &Role,
  providers: &[Provider],
) -> Result<(String, Option<Entry>), GateError> {
  if let Some(active) = &role.provider
    && let Some(entry) = entry_on(role, providers, active)
  {
    return Ok((active.clone(), Some(entry)));
  }

  if let Some(entry) = role.order.iter().find(|entry| enabled(providers, &entry.provider)) {
    return Ok((entry.provider.clone(), Some(entry.clone())));
  }

  role
    .order
    .first()
    .map(|entry| (entry.provider.clone(), None))
    .ok_or_else(|| fault(format!("{stage}: the role {} has no provider order of its own", role.name)))
}

/// The gate's road.
pub async fn read(runs: &Runs, stage: &str) -> Result<Route, GateError> {
  read_on(runs, stage, None).await
}

/// The gate's road as it reads on a provider its caller names in place of the one it goes out on — a gate
/// evaluation scoring it, for one. A provider named that is off, or that the role's order holds no entry for,
/// serves the run nothing.
pub async fn read_on(runs: &Runs, stage: &str, on: Option<&str>) -> Result<Route, GateError> {
  let role = read_role(runs, stage).await?;
  let providers = runs.agency.providers().await.map_err(fault)?;
  let (provider, mapping) = match on {
    Some(on) => (on.to_owned(), entry_on(&role, &providers, on)),
    None => road_provider(stage, &role, &providers)?,
  };

  Ok(Route {
    gate: stage.to_owned(),
    way: way_of(&providers, &provider),
    provider,
    role: role.name,
    mapping,
  })
}

/// The gate's road as it reads on one registration its caller names in place of its own — the model an agent's
/// recollectors go out on: the first provider whose models are registrations, that registration as its model
/// with the effort, the thinking and the answer ceiling the role's entry for that provider names, and nothing
/// behind it.
pub async fn read_registered(runs: &Runs, stage: &str, registration: &str) -> Result<Route, GateError> {
  let role = read_role(runs, stage).await?;
  let providers = runs.agency.providers().await.map_err(fault)?;
  let Some(provider) = providers.iter().find(|one| one.registered) else {
    return Err(fault(format!("{stage}: no provider serves registrations to run {registration} on")));
  };
  let named = role.order.iter().find(|entry| entry.provider == provider.name);
  let mapping = Entry {
    provider: provider.name.clone(),
    model: registration.to_owned(),
    effort: named.and_then(|entry| entry.effort.clone()),
    thinking: named.and_then(|entry| entry.thinking.clone()),
    answer_tokens: named.and_then(|entry| entry.answer_tokens),
  };

  Ok(Route {
    gate: stage.to_owned(),
    provider: provider.name.clone(),
    way: Way::Gateway,
    role: role.name,
    mapping: provider.enabled.then_some(mapping),
  })
}
