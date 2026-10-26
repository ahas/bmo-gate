//! The reference road's tests: a turn's reference composed against a stand-in brain, receiver and bmo-job on a
//! scratch database of the test's own, each gate's model a gateway answering by what it is asked; the narrowing's and
//! the pickers' readings; the situation matcher; and the watch on what attaches.

#[path = "../runs/fakes.rs"]
mod agency;
mod fakes;
#[path = "../support/scratch.rs"]
mod scratch;

mod attachments;
mod index;
mod memories;
mod narrow;
mod pick;
mod road;
mod situation;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gate_policy::profiles::PROFILES;
use gate_ports::gateway::Ask;
use gate_reference::Reference;
use gate_runs::Runs;
use gate_stages::laya::Side;
use gate_stages::{Reading, Stages};
use serde_json::json;

use crate::agency::{FakeAgency, mapping, provider};
use crate::fakes::{AnsweringGateway, FakeBrain, FakeReceiver, PausingGateway};
use crate::scratch::Scratch;

/// A migrated store, the stand-ins, a wait of thirty seconds for every gate, a folder of the test's own for the
/// shipped pieces, and the reference road over them, each gate's model answering as `answer` makes it.
pub struct Ground {
  pub scratch: Scratch,
  pub brain: Arc<FakeBrain>,
  pub receiver: Arc<FakeReceiver>,
  pub gateway: Arc<AnsweringGateway>,
  pub shipped: PathBuf,
  pub reference: Reference,
}

pub async fn ground(test: &str, answer: impl Fn(&Ask) -> Option<String> + Send + Sync + 'static) -> Ground {
  paused_ground(test, answer, Duration::ZERO).await
}

/// The same ground, each gate's model answering a pause after it is asked.
pub async fn paused_ground(
  test: &str,
  answer: impl Fn(&Ask) -> Option<String> + Send + Sync + 'static,
  pause: Duration,
) -> Ground {
  let scratch = Scratch::new().await;
  let agency = Arc::new(FakeAgency::default());
  let gateway = Arc::new(AnsweringGateway {
    answer: Box::new(answer),
    asked: Mutex::default(),
  });
  let runs = Runs::new(
    scratch.db().clone(),
    agency.clone(),
    Arc::new(PausingGateway {
      inner: gateway.clone(),
      pause,
    }),
    "the-chat-agent",
    "/a/session/folder",
  );

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

  let shipped = std::env::temp_dir().join(format!("gate-reference-{}-{test}", std::process::id()));

  std::fs::create_dir_all(&shipped).unwrap();

  let side = Side::new(scratch.db().clone(), None, None, "the-chat-agent");
  let stages = Arc::new(Stages::new(runs, side, Reading::default()));
  let brain = Arc::new(FakeBrain::default());
  let receiver = Arc::new(FakeReceiver::default());
  let reference = Reference {
    stages,
    brain: brain.clone(),
    receiver: receiver.clone(),
    shipped: Some(shipped.clone()),
  };

  Ground {
    scratch,
    brain,
    receiver,
    gateway,
    shipped,
    reference,
  }
}

/// The slugs a picker's index offers, in order.
pub fn offered_slugs(input: &str) -> Vec<String> {
  input
    .lines()
    .filter_map(|line| line.strip_prefix("- "))
    .filter_map(|line| line.split_whitespace().next())
    .map(str::to_owned)
    .collect()
}
