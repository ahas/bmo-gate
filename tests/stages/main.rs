//! The stages' tests: the translator, a document's translation and the records they read, each carried against a
//! stand-in agency on a scratch database of the test's own.

#[path = "../runs/fakes.rs"]
mod fakes;
#[path = "../support/scratch.rs"]
mod scratch;
#[path = "../support/stub.rs"]
mod stub;

mod document_translation;
mod markdown;
mod markdown_shape;
mod records;
mod translator;

use std::sync::Arc;

use gate_stages::{Reading, Stages};

use crate::fakes::{FakeAgency, FakeGateway, mapping, provider};
use crate::scratch::Scratch;

/// A migrated store, stand-ins for the agency and its gateway with one registered provider, and the stages on
/// them.
pub struct Ground {
  pub scratch: Scratch,
  pub agency: Arc<FakeAgency>,
  pub gateway: Arc<FakeGateway>,
  pub stages: Arc<Stages>,
}

pub async fn ground(test: &str, reading: Reading) -> Ground {
  let _ = test;
  let scratch = Scratch::new().await;
  let agency = Arc::new(FakeAgency::default());
  let gateway = Arc::new(FakeGateway::default());
  let runs = fakes::runs(scratch.db(), &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("registry", true));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("registry".into(), mapping("registry", "a-registration", None, None));

  let stages = Arc::new(Stages::new(runs, reading));

  Ground {
    scratch,
    agency,
    gateway,
    stages,
  }
}
