//! The unit command's tests: the nouns it declares and the words it reads, the format cases and the Laya agreement
//! read off a scratch database, the replay bench against a stand-in gateway, and the evaluation set's members,
//! generation on a scripted Codex and scoring on a registration, each over a data root of the test's own.

#[path = "../runs/fakes.rs"]
mod fakes;
#[path = "../support/scratch.rs"]
mod scratch;

mod bench;
mod eval;
mod format_cases;
mod laya_agreement;
mod members;
mod nouns;

use std::path::PathBuf;
use std::sync::Arc;

use gate_policy::profiles::PROFILES;
use gate_runs::RecordFolders;
use gate_stages::laya::Side;
use gate_stages::{Reading, Stages};
use serde_json::json;

use crate::fakes::{FakeAgency, FakeGateway, mapping, provider};
use crate::scratch::Scratch;

/// A migrated store, stand-ins for the agency and its gateway with one registered provider every gate maps to, a
/// wait of thirty seconds for every gate, the gates on them, and a data root of the test's own.
pub struct Ground {
  pub scratch: Scratch,
  pub agency: Arc<FakeAgency>,
  pub gateway: Arc<FakeGateway>,
  pub stages: Arc<Stages>,
  pub data_root: PathBuf,
}

/// A folder of the test's own, empty.
pub fn folder(test: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("gate-command-{}-{test}", std::process::id()));

  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

pub async fn ground(test: &str) -> Ground {
  let scratch = Scratch::new().await;
  let agency = Arc::new(FakeAgency::default());
  let gateway = Arc::new(FakeGateway::default());
  let runs = fakes::runs(scratch.db(), &agency, &gateway, RecordFolders::default());

  agency.providers.lock().unwrap().push(provider("registry", true));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("registry".into(), mapping("registry", "a-registration", None, None));

  for profile in &PROFILES.profile {
    gate_runs::options::change(&runs, &profile.key, &json!({ "timeout_ms": 30_000 }), 1)
      .await
      .unwrap();
  }

  let side = Side::new(scratch.db().clone(), None, None, "the-chat-agent");
  let stages = Arc::new(Stages::new(runs, side, Reading::default()));

  Ground {
    scratch,
    agency,
    gateway,
    stages,
    data_root: folder(test),
  }
}
