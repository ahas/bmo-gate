//! The runs' tests: a gate's run carried on each road against a stand-in agency and gateway, what it records in a
//! scratch database of each test's own, the gate options, the pool, the session summariser and the trials.

#[path = "../support/scratch.rs"]
mod scratch;

mod fakes;
mod options;
mod pool;
mod run;
mod summary;
mod tried;

use std::sync::Arc;

use serde_json::json;

use crate::fakes::{FakeAgency, FakeGateway};
use crate::scratch::Scratch;

/// A migrated store and fresh stand-ins.
pub async fn ground() -> (Scratch, Arc<FakeAgency>, Arc<FakeGateway>) {
  (Scratch::new().await, Arc::new(FakeAgency::default()), Arc::new(FakeGateway::default()))
}

/// The chat agent's wait for a gate written through the options, as the console writes it.
pub async fn wait(runs: &gate_runs::Runs, stage: &str, ms: i64) {
  gate_runs::options::change(runs, stage, &json!({ "timeoutMs": ms }), 1).await.unwrap();
}

/// The runs over a ground.
pub fn runs_of(scratch: &Scratch, agency: &Arc<FakeAgency>, gateway: &Arc<FakeGateway>) -> gate_runs::Runs {
  fakes::runs(scratch.db(), agency, gateway)
}
