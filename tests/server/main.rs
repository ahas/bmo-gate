//! The service's contract tests: the router served on the loopback over a scratch database of the test's own, the
//! agency, the brain, the receiver and bmo-job stood in, and every route driven with the bodies its callers send —
//! bmo-receiver's, bmo-job's, bmo-brain's, bmo-artifact's, the agency's hook, the voice unit's and the console's.

#[path = "../runs/fakes.rs"]
mod agency;
#[path = "../reference/fakes.rs"]
mod fakes;
#[path = "../support/scratch.rs"]
mod scratch;

mod brain;
mod console;
mod hooks;
mod receiver;
mod wire;
mod work;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gate_policy::profiles::PROFILES;
use gate_ports::gateway::Ask;
use gate_reference::Reference;
use gate_runs::{RecordFolders, Runs};
use gate_server::App;
use gate_stages::document_translation::Queue;
use gate_stages::laya::Side;
use gate_stages::{Reading, Stages};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

use crate::agency::{FakeAgency, mapping, provider};
use crate::fakes::{AnsweringGateway, FakeBrain, FakeJob, FakeReceiver, fragment};
use crate::scratch::Scratch;

/// The token every caller presents.
pub const TOKEN: &str = "the-gate-token";

/// The room the tests' turns are in.
pub const ROOM: i64 = 7;

/// A migrated store, the stand-ins, a wait of thirty seconds for every gate, the service over them, and its
/// address on the loopback.
pub struct Ground {
  pub scratch: Scratch,
  pub agency: Arc<FakeAgency>,
  pub brain: Arc<FakeBrain>,
  pub gateway: Arc<AnsweringGateway>,
  pub job: Arc<FakeJob>,
  pub app: Arc<App>,
  pub address: String,
  pub client: reqwest::Client,
}

/// The ground with every gate's model answering as `answer` makes it.
pub async fn ground(test: &str, answer: impl Fn(&Ask) -> Option<String> + Send + Sync + 'static) -> Ground {
  let scratch = Scratch::new().await;
  let agency = Arc::new(FakeAgency::default());
  let gateway = Arc::new(AnsweringGateway {
    answer: Box::new(answer),
    asked: Mutex::default(),
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
    gate_runs::options::change(&runs, &profile.key, &json!({ "timeoutMs": 30_000 }), 1)
      .await
      .unwrap();
  }

  let data_root = std::env::temp_dir().join(format!("gate-server-{}-{test}", std::process::id()));

  std::fs::create_dir_all(&data_root).unwrap();

  let side = Side::new(scratch.db().clone(), None, None, "the-chat-agent");
  let stages = Arc::new(Stages::new(runs, side, Reading::default()));
  let brain = Arc::new(FakeBrain::default());
  let job = Arc::new(FakeJob::default());
  let reference = Arc::new(Reference {
    stages: stages.clone(),
    brain: brain.clone(),
    receiver: Arc::new(FakeReceiver::default()),
    shipped: None,
  });
  let app = Arc::new(App {
    stages,
    reference,
    job: job.clone(),
    queue: Queue::default(),
    token: TOKEN.to_owned(),
    owner_room: 1,
    data_root: PathBuf::from(&data_root),
  });
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let address = format!("http://{}", listener.local_addr().unwrap());

  tokio::spawn(axum::serve(listener, gate_server::router(app.clone())).into_future());

  Ground {
    scratch,
    agency,
    brain,
    gateway,
    job,
    app,
    address,
    client: reqwest::Client::new(),
  }
}

impl Ground {
  /// A route asked with the gate's token, answering its status and its body, null where it has none.
  pub async fn call(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = self.client.request(method, format!("{}{path}", self.address)).bearer_auth(TOKEN);

    if let Some(body) = body {
      request = request.json(&body);
    }

    let response = request.send().await.unwrap();
    let status = response.status();
    let bytes = response.bytes().await.unwrap();
    let body = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() };

    (status, body)
  }

  pub async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
    self.call(Method::POST, path, Some(body)).await
  }

  pub async fn put(&self, path: &str, body: Value) -> (StatusCode, Value) {
    self.call(Method::PUT, path, Some(body)).await
  }

  pub async fn get(&self, path: &str) -> (StatusCode, Value) {
    self.call(Method::GET, path, None).await
  }

  /// The brain holding a room's knowledge: a deploy note and a note about the office cat, each with its body.
  pub fn furnish(&self) {
    self.brain.fragments.lock().unwrap().extend([
      fragment("library-knowledge", "deploy-notes", "how a deploy goes", None, None),
      fragment("library-knowledge", "kittens", "the office cat", None, None),
    ]);
    self
      .brain
      .documents
      .lock()
      .unwrap()
      .insert("deploy-notes".to_owned(), "Deploys go through the testbed.".to_owned());
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

/// A gateway answering a picker yes for the slugs wanted and no for the rest, and nothing to any other gate.
pub fn picking(wanted: &'static [&'static str]) -> impl Fn(&Ask) -> Option<String> + Send + Sync {
  move |ask| {
    let slugs = offered_slugs(&ask.input);

    (!slugs.is_empty()).then(|| {
      slugs
        .iter()
        .map(|slug| format!("{slug}: {}", if wanted.contains(&slug.as_str()) { "yes" } else { "no" }))
        .collect::<Vec<_>>()
        .join("\n")
    })
  }
}

/// A refusal's body: exactly its sentence and its code, the code as given.
pub fn refused(body: &Value, code: &str) {
  let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();

  assert_eq!(body["code"], code, "{body}");
  assert!(body["error"].as_str().is_some_and(|error| !error.is_empty()), "{body}");
  assert_eq!(keys.len(), 2, "{body}");
}
