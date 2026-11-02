//! The gate runs this service holds while they go, which the live board draws: a gate run is the service's own,
//! so its memory is the fact — a run is live from the moment it is asked until it returns, and a service that
//! ends takes its runs out with it.

use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

/// One gate run as the board draws it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateRun {
  pub id: u64,
  pub stage: String,
  pub chat_id: Option<i64>,
  pub message_id: Option<i64>,
  /// When it was asked, in seconds.
  pub started_at: i64,
}

static RUNS: LazyLock<Mutex<BTreeMap<u64, GateRun>>> = LazyLock::new(Mutex::default);

fn runs() -> MutexGuard<'static, BTreeMap<u64, GateRun>> {
  RUNS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A gate run held in the picture for as long as this stands.
pub struct Held(u64);

impl Drop for Held {
  fn drop(&mut self) {
    runs().remove(&self.0);
  }
}

/// A gate run put into the picture until what this answers is dropped.
pub fn hold(run: GateRun) -> Held {
  let id = run.id;

  runs().insert(id, run);
  Held(id)
}

/// The gate runs going now, in the order they were asked.
pub fn now() -> Vec<GateRun> {
  runs().values().cloned().collect()
}
