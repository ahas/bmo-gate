//! How many runs of one gate stand at once (`docs/boundary-api.md`, 「How a gate run reaches a model」): a gate
//! whose road is a provider's program stands as many thrown-away sessions at once as its pool's bound, and a gate
//! whose road is the gateway takes its runs in turns, the next waiting until the previous one has returned. A run
//! waits in line for its place however long that takes, and is never turned away.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use gate_policy::profiles::PROFILES;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::route::{Route, Way};

/// The most runs a gate stands at once on a way: its pool's bound on a provider's program, one on the gateway.
pub fn bound(stage: &str, way: Way) -> usize {
  match way {
    Way::Session => PROFILES.of(stage).map_or(1, |profile| profile.pool_bound()).max(1),
    Way::Gateway => 1,
  }
}

/// The places of every gate's pool in this service, by the gate and the way its road takes.
#[derive(Default)]
pub struct Pools {
  places: Mutex<HashMap<(String, Way), Arc<Semaphore>>>,
}

/// A place a run holds in its gate's pool until it is dropped.
pub struct Place(#[allow(dead_code)] OwnedSemaphorePermit);

impl Pools {
  fn of(&self, stage: &str, way: Way) -> Arc<Semaphore> {
    self
      .places
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
      .entry((stage.to_owned(), way))
      .or_insert_with(|| Arc::new(Semaphore::new(bound(stage, way))))
      .clone()
  }

  /// A place of the gate's pool for a run on its road, waited for in line until one comes free.
  pub async fn take(&self, stage: &str, route: &Route) -> Place {
    let places = self.of(stage, route.way);

    Place(places.acquire_owned().await.expect("a pool's places are never closed"))
  }
}
