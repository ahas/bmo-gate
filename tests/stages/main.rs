//! The gates' tests: each gate carried against a stand-in agency and gateway on a scratch database of the test's
//! own, Laya asked of a stand-in relay on the loopback, and the readings and records each leaves.

#[path = "../runs/fakes.rs"]
mod fakes;
#[path = "../support/scratch.rs"]
mod scratch;
#[path = "../support/stub.rs"]
mod stub;

mod document_seek;
mod document_translation;
mod fold;
mod laya;
mod laya_agreement;
mod laya_health;
mod markdown;
mod markdown_shape;
mod output;
mod records;
mod retention;
mod sanitizer;
mod translator;

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use gate_policy::profiles::PROFILES;
use gate_stages::laya::Side;
use gate_stages::{Reading, Stages};
use serde_json::json;

use crate::fakes::{FakeAgency, FakeGateway, mapping, provider};
use crate::scratch::Scratch;
use crate::stub::Stub;

/// A migrated store, stand-ins for the agency and its gateway with one registered provider every gate maps to, a
/// wait of thirty seconds for every gate, and the gates on them, asking Laya at `laya` where one is given.
pub struct Ground {
  pub scratch: Scratch,
  pub agency: Arc<FakeAgency>,
  pub gateway: Arc<FakeGateway>,
  pub stages: Arc<Stages>,
}

/// A token file of the test's own, private as the client takes one.
pub fn token_file(test: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("gate-stages-{}-{test}", std::process::id()));

  std::fs::create_dir_all(&dir).unwrap();

  let file = dir.join("laya.token");

  std::fs::write(&file, "relay-token\n").unwrap();
  std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
  file
}

pub async fn ground(test: &str, laya: Option<&Stub>, reading: Reading) -> Ground {
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

  for profile in &PROFILES.profile {
    gate_runs::options::change(&runs, &profile.key, &json!({ "timeoutMs": 30_000 }), 1)
      .await
      .unwrap();
  }

  let side = Side::new(
    scratch.db().clone(),
    laya.map(|stub| stub.address.as_str()),
    Some(token_file(test)),
    "the-chat-agent",
  );
  let stages = Arc::new(Stages::new(runs, side, reading));

  Ground {
    scratch,
    agency,
    gateway,
    stages,
  }
}
