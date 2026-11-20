//! The service's contract tests: the router served on the loopback over a scratch database of the test's own, the
//! agency, the brain and the receiver stood in, every route driven with the bodies its callers send, and the
//! watches beside them as the agency sees them, and the service stopped and drained.

mod receiver;
mod restart;
mod stop;
mod watches;
mod whose;
mod wire;
mod work;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gate_ports::accounts::NoAccounts;
use gate_ports::gateway::Ask;
use gate_reference::Reference;
use gate_runs::Runs;
use gate_server::App;
use gate_server::stop::Stop;
use gate_stages::document_translation::Queue;
use gate_stages::translator::Intake;
use gate_stages::{Reading, Stages};
use reqwest::{Method, StatusCode};
use serde_json::Value;

use crate::reference::fakes::{AnsweringGateway, FakeBrain, FakeReceiver, fragment};
use crate::runs::fakes::{FakeAgency, provider};
use crate::support::scratch::Scratch;

/// The token every caller presents.
pub const TOKEN: &str = "the-gate-token";

/// The room the tests' turns are in.
pub const ROOM: i64 = 7;

/// A migrated store, the stand-ins, the service over them, and its address on the loopback.
pub struct Ground {
  pub scratch: Scratch,
  pub brain: Arc<FakeBrain>,
  pub agency: Arc<FakeAgency>,
  pub gateway: Arc<AnsweringGateway>,
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
  );

  agency.providers.lock().unwrap().push(provider("registry", true));

  let data_root = std::env::temp_dir().join(format!("gate-server-{}-{test}", std::process::id()));

  std::fs::create_dir_all(&data_root).unwrap();

  let stages = Arc::new(Stages::new(runs, Reading::default()));
  let brain = Arc::new(FakeBrain::default());
  let reference = Arc::new(Reference {
    stages: stages.clone(),
    brain: brain.clone(),
    accounts: Arc::new(NoAccounts),
    receiver: Arc::new(FakeReceiver::default()),
    shipped: None,
  });
  let app = Arc::new(App {
    stages,
    reference,
    queue: Queue::default(),
    translations: Intake::of_policy(),
    token: TOKEN.to_owned(),
    data_root: PathBuf::from(&data_root),
    stop: Stop::default(),
  });
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let address = format!("http://{}", listener.local_addr().unwrap());

  tokio::spawn(axum::serve(listener, gate_server::router(app.clone())).into_future());

  Ground {
    scratch,
    brain,
    agency,
    gateway,
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

/// A refusal's body: exactly its sentence and its code, the code as given.
pub fn refused(body: &Value, code: &str) {
  let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();

  assert_eq!(body["code"], code, "{body}");
  assert!(body["error"].as_str().is_some_and(|error| !error.is_empty()), "{body}");
  assert_eq!(keys.len(), 2, "{body}");
}
