//! The runs' tests: the gate options and the pool over a scratch database of each test's own.

#[path = "../support/scratch.rs"]
mod scratch;

mod fakes;
mod options;
mod pool;

use std::sync::Arc;

use crate::fakes::{FakeAgency, FakeGateway};
use crate::scratch::Scratch;

/// A migrated store and fresh stand-ins.
pub async fn ground() -> (Scratch, Arc<FakeAgency>, Arc<FakeGateway>) {
  (Scratch::new().await, Arc::new(FakeAgency::default()), Arc::new(FakeGateway::default()))
}

/// The runs over a ground.
pub fn runs_of(scratch: &Scratch, agency: &Arc<FakeAgency>, gateway: &Arc<FakeGateway>) -> gate_runs::Runs {
  fakes::runs(scratch.db(), agency, gateway)
}
