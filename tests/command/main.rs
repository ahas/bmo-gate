//! The unit command's tests: the nouns it declares and the words it reads, its health check against a stand-in service, the format cases, the Laya agreement
//! and the gate's records read off a scratch database, the replay bench against a stand-in gateway, the evaluation set's members,
//! generation on a scripted Codex and scoring on a registration, and the reference road's benches against a
//! stand-in brain and receiver, each over a data root of the test's own.

#[path = "../runs/fakes.rs"]
mod fakes;
#[path = "../support/scratch.rs"]
mod scratch;
#[path = "../reference/fakes.rs"]
mod units;

mod bench;
mod eval;
mod format_cases;
mod health;
mod laya_agreement;
mod members;
mod nouns;
mod records;
mod reference;

use std::path::PathBuf;
use std::sync::Arc;

use gate_policy::profiles::PROFILES;
use gate_ports::gateway::Ask;
use gate_reference::Reference;
use gate_runs::{RecordFolders, Runs};
use gate_stages::laya::Side;
use gate_stages::{Reading, Stages};
use serde_json::json;

use crate::fakes::{FakeAgency, FakeGateway, mapping, provider};
use crate::scratch::Scratch;
use crate::units::{AnsweringGateway, FakeBrain, FakeReceiver};

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

/// A migrated store, the stand-in agency, a gateway answering each request as `answer` makes it, a stand-in brain
/// and receiver, and the reference road over them, its shipped pieces under a folder of the test's own.
pub struct RoadGround {
  pub scratch: Scratch,
  pub brain: Arc<FakeBrain>,
  pub receiver: Arc<FakeReceiver>,
  pub gateway: Arc<AnsweringGateway>,
  pub reference: Arc<Reference>,
  pub shipped: PathBuf,
}

pub async fn road_ground(
  test: &str,
  answer: impl Fn(&Ask) -> Option<String> + Send + Sync + 'static,
) -> RoadGround {
  let scratch = Scratch::new().await;
  let agency = Arc::new(FakeAgency::default());
  let gateway = Arc::new(AnsweringGateway {
    answer: Box::new(answer),
    asked: std::sync::Mutex::default(),
  });
  let runs = Runs::new(
    scratch.db().clone(),
    agency.clone(),
    gateway.clone(),
    "the-chat-agent",
    "/a/session/folder",
    RecordFolders::default(),
  );

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

  let shipped = folder(test).join("shipped");

  std::fs::create_dir_all(&shipped).unwrap();

  let side = Side::new(scratch.db().clone(), None, None, "the-chat-agent");
  let stages = Arc::new(Stages::new(runs, side, Reading::default()));
  let brain = Arc::new(FakeBrain::default());
  let receiver = Arc::new(FakeReceiver::default());
  let reference = Arc::new(Reference {
    stages,
    brain: brain.clone(),
    receiver: receiver.clone(),
    shipped: Some(shipped.clone()),
  });

  RoadGround {
    scratch,
    brain,
    receiver,
    gateway,
    reference,
    shipped,
  }
}
