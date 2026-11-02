//! The reference road's tests: a turn's reference composed against a stand-in brain and receiver on a scratch
//! database of the test's own, a gateway standing for any model, which the road never asks; the memories entry; the
//! woken rows; and the brain's index.

pub(crate) mod fakes;

mod index;
mod memories;
mod road;
mod situation;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use gate_ports::gateway::Ask;
use gate_reference::Reference;
use gate_runs::Runs;
use gate_stages::{Reading, Stages};

use crate::reference::fakes::{AnsweringGateway, FakeBrain, FakeReceiver, PausingGateway};
use crate::runs::fakes::{FakeAgency, mapping, provider};
use crate::support::scratch::Scratch;

/// A migrated store, the stand-ins, a folder of the test's own for the shipped pieces, and the reference road over
/// them, each gate's model answering as `answer` makes it.
pub struct Ground {
  _scratch: Scratch,
  pub brain: Arc<FakeBrain>,
  pub gateway: Arc<AnsweringGateway>,
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

  let shipped = std::env::temp_dir().join(format!("gate-reference-{}-{test}", std::process::id()));

  std::fs::create_dir_all(&shipped).unwrap();

  let stages = Arc::new(Stages::new(runs, Reading::default()));
  let brain = Arc::new(FakeBrain::default());
  let receiver = Arc::new(FakeReceiver::default());
  let reference = Reference {
    stages,
    brain: brain.clone(),
    receiver,
    shipped: Some(shipped),
  };

  Ground {
    _scratch: scratch,
    brain,
    gateway,
    reference,
  }
}
