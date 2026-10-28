//! A gate's one road as its run reads it (`docs/boundary-api.md`, 「How a gate run reaches a model」): the
//! provider it begins on, as the work key's run mode names it or the agency's walk finds it; the mapping the
//! gate's tier resolves to there; whether the provider's program carries the run or the gateway does; and
//! whether the gate stands on Laya.

use gate_policy::profiles::PROFILES;
use gate_ports::agency::{Mapping, Provider};

use crate::{GateError, Runs, fault};

/// The run mode of a work key that stands on Laya.
pub const LAYA: &str = "laya";

/// The run mode of a work key that walks the providers in the owner's order.
pub const AUTO: &str = "auto";

/// The line a gate's run goes out on, which a provider's program carries or not.
pub const LINE: &str = "gate";

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
  /// The agency's work key the run goes out under: the gate's own.
  pub key: String,
  /// Whether the gate stands on Laya, which no model run answers.
  pub laya: bool,
  /// The provider the road begins on.
  pub provider: String,
  pub way: Way,
  /// The gate's tier, which the mapping was resolved at.
  pub tier: String,
  /// The mapping the tier resolves to on the provider; none where the provider serves the gate nothing now.
  pub mapping: Option<Mapping>,
}

impl Route {
  /// The model the road goes out on, as its mapping names it; empty where it names none.
  pub fn model(&self) -> &str {
    self.mapping.as_ref().and_then(|mapping| mapping.model.as_deref()).unwrap_or_default()
  }
}

/// The tier a gate's profile names, which every mapping of it is resolved at.
pub fn tier_of(stage: &str) -> Result<String, GateError> {
  PROFILES
    .of(stage)
    .map(|profile| profile.tier.clone())
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

/// The run mode the work key stands on, as the agency's fallback settings hold it; the walk where they hold
/// none.
pub async fn run_mode(runs: &Runs, stage: &str) -> Result<String, GateError> {
  let route = runs.agency.work_key(stage).await.map_err(fault)?;

  Ok(route.map_or_else(|| AUTO.to_owned(), |route| route.route_mode))
}

/// The provider a gate's road begins on, with the mapping its tier resolves to there: the one its run mode names
/// where that is on, else the first the agency's walk finds serving it, else the first that carries a gate's
/// line, with nothing it maps to.
pub async fn road_provider(
  runs: &Runs,
  stage: &str,
  mode: &str,
  providers: &[Provider],
  tier: &str,
) -> Result<(String, Option<Mapping>), GateError> {
  if mode != AUTO && mode != LAYA && enabled(providers, mode) {
    let mapping = runs.agency.resolve(stage, Some(mode), tier).await.map_err(fault)?;

    return Ok((mode.to_owned(), mapping));
  }

  if let Some(mapping) = runs.agency.resolve(stage, None, tier).await.map_err(fault)?
    && let Some(provider) = mapping.provider.clone()
  {
    return Ok((provider, Some(mapping)));
  }

  providers
    .iter()
    .filter(|one| one.enabled)
    .find(|one| one.lines.iter().any(|line| line == LINE))
    .or_else(|| providers.iter().find(|one| one.enabled))
    .map(|one| (one.name.clone(), None))
    .ok_or_else(|| fault("no provider is on"))
}

/// The gate's road.
pub async fn read(runs: &Runs, stage: &str) -> Result<Route, GateError> {
  read_on(runs, stage, None).await
}

/// The gate's road as it reads on a provider its caller names in place of the one it begins on — a gate on Laya
/// asking its fallback LLM, a gate evaluation scoring it — which is never Laya. A provider named that is off
/// serves the run nothing.
pub async fn read_on(runs: &Runs, stage: &str, on: Option<&str>) -> Result<Route, GateError> {
  let tier = tier_of(stage)?;
  // A gate's runs go out under its own work key, the gate's name (docs/gates.md, 「Where a gate's runs go out」).
  let key = stage.to_owned();
  let providers = runs.agency.providers().await.map_err(fault)?;
  let (laya, provider, mapping) = match on {
    Some(on) => {
      let mapping = if enabled(&providers, on) {
        runs.agency.resolve(&key, Some(on), &tier).await.map_err(fault)?
      } else {
        None
      };

      (false, on.to_owned(), mapping)
    }
    None => {
      let mode = run_mode(runs, &key).await?;

      // A gate on Laya runs no model, so no mapping is read for it.
      if mode == LAYA {
        (true, LAYA.to_owned(), None)
      } else {
        let (provider, mapping) = road_provider(runs, &key, &mode, &providers, &tier).await?;

        (false, provider, mapping)
      }
    }
  };

  Ok(Route {
    key,
    laya,
    way: way_of(&providers, &provider),
    provider,
    tier,
    mapping,
  })
}

/// The gate's road as it reads on one registration its caller names in place of its own — the model an agent's
/// recollectors go out on: the first provider whose models are registrations, that registration as its model
/// with the gate's own tier's room there, and nothing behind it.
pub async fn read_registered(runs: &Runs, stage: &str, registration: &str) -> Result<Route, GateError> {
  let tier = tier_of(stage)?;
  let providers = runs.agency.providers().await.map_err(fault)?;
  let Some(provider) = providers.iter().find(|one| one.registered) else {
    return Err(fault(format!("{stage}: no provider serves registrations to run {registration} on")));
  };
  let resolved = if provider.enabled {
    runs.agency.resolve(stage, Some(&provider.name), &tier).await.map_err(fault)?
  } else {
    None
  };
  let mapping = Mapping {
    provider: Some(provider.name.clone()),
    tier: Some(tier.clone()),
    model: Some(registration.to_owned()),
    effort: resolved.as_ref().and_then(|one| one.effort.clone()),
    answer_tokens: resolved.as_ref().and_then(|one| one.answer_tokens),
  };

  Ok(Route {
    key: stage.to_owned(),
    laya: false,
    provider: provider.name.clone(),
    way: Way::Gateway,
    tier,
    mapping: provider.enabled.then_some(mapping),
  })
}
