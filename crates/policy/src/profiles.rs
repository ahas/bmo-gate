//! Each gate's profile: what the gate itself declares about how it runs, read beside the gate order and served
//! with it by `GET /gates`. The road a gate takes and the model its tier maps to are its work key's, which the
//! agency keeps and resolves.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::gate_pool::GATE_POOL;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profiles {
  pub profile: Vec<Profile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
  pub key: String,
  /// The gate's word for its work, which the agency maps to a provider's model and effort.
  pub tier: String,
  /// The owner may switch it off, since its caller has a way of its own without it.
  #[serde(default)]
  pub switchable: bool,
  /// Its runs are asked about a session rather than held as one.
  #[serde(default)]
  pub holds_no_session: bool,
  /// The room its answer is given, where its answer is not the shape the common default was measured against.
  #[serde(default)]
  pub answer_tokens: Option<i64>,
  /// How a run of it with no tools samples, each setting by the name the engine reads it under.
  #[serde(default)]
  pub sampling: Option<BTreeMap<String, f64>>,
  /// The most of its runs out at once, where its callers keep more parts out than the pool's default.
  #[serde(default)]
  pub pool: Option<usize>,
}

impl Profile {
  /// The most of its runs out at once.
  pub fn pool_bound(&self) -> usize {
    self.pool.unwrap_or(GATE_POOL.size)
  }
}

impl Profiles {
  pub fn of(&self, key: &str) -> Option<&Profile> {
    self.profile.iter().find(|one| one.key == key)
  }
}

crate::part!(pub PROFILES: Profiles = "gate-profiles.toml");
