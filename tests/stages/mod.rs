//! The stages' tests: the translator, a document's translation and the records they read, each carried against a
//! stand-in agency on a scratch database of the test's own.

mod document_translation;
mod markdown;
mod markdown_shape;
mod records;
mod translator;

use std::sync::Arc;

use gate_stages::{Reading, Stages};

use crate::runs::fakes::{FakeAgency, FakeGateway, provider};
use crate::support::scratch::Scratch;

/// A migrated store, stand-ins for the agency and its gateway with one registered provider, and the stages on
/// them.
pub struct Ground {
  pub scratch: Scratch,
  pub agency: Arc<FakeAgency>,
  pub stages: Arc<Stages>,
}

pub async fn ground(test: &str, reading: Reading) -> Ground {
  let _ = test;
  let scratch = Scratch::new().await;
  let agency = Arc::new(FakeAgency::default());
  let gateway = Arc::new(FakeGateway::default());
  let runs = crate::runs::fakes::runs(scratch.db(), &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("registry", true));

  let stages = Arc::new(Stages::new(runs, reading));

  Ground {
    scratch,
    agency,
    stages,
  }
}
