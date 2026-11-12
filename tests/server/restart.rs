//! Work in flight across a restart, the service run as the deployment runs it, `gate-server` started on its settings
//! and stopped by SIGTERM, against a stand-in agency the test stops and starts on one port: a translation run the
//! agency cuts and leaves unanswered while it is down is answered once it is back; the gate stopped and started
//! again reads the agency's roads on from the last it wrote; and a gate stopped with a call in hand tells its
//! stream, takes no new connection and answers the call before it ends.

use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use gate_ports::Peer;
use gate_ports::agency::{Agency, HttpAgency, TranslationAsk};
use gate_ports::http::Patience;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::timeout;

use super::{ROOM, TOKEN};
use crate::support::agency::{Run, StandInAgency};
use crate::support::scratch::Scratch;
use crate::support::stub::Stub;

// The longest any of these waits on a condition.
const BOUND: Duration = Duration::from_secs(20);

// A Korean greeting, as a worker's record holds it.
const GREETING: &str = "\u{c548}\u{b155}\u{d558}\u{c138}\u{c694}";

// Waits until `holds` answers true, `BOUND` at most, and says whether it did.
async fn until<F: std::future::Future<Output = bool>>(mut holds: impl FnMut() -> F) -> bool {
  let deadline = tokio::time::Instant::now() + BOUND;

  while tokio::time::Instant::now() < deadline {
    if holds().await {
      return true;
    }

    tokio::time::sleep(Duration::from_millis(20)).await;
  }

  false
}

#[tokio::test]
async fn a_translation_run_the_agency_cuts_and_answers_after_its_restart_is_answered() {
  let agency = StandInAgency::start().await;
  let patience = Patience {
    first: Duration::from_millis(10),
    most: Duration::from_millis(10),
  };
  let port =
    HttpAgency::new(Peer::new(&agency.address(), Some("t".to_owned())).unwrap()).with_patience(patience);
  let ask = TranslationAsk {
    purpose: "worker".into(),
    language: "English".into(),
    text: "a text".into(),
    note: None,
  };

  agency.script(vec![Run::Held("never sent".into())]);

  let running = tokio::spawn(async move { port.translation_run(&ask).await });

  timeout(BOUND, agency.heard()).await.unwrap();

  // The agency stops with the run in hand: its connection is cut, and while it is down every ask is refused.
  agency.stop().await;
  assert!(
    TcpStream::connect(agency.at).await.is_err(),
    "the stopped agency still took a connection"
  );
  tokio::time::sleep(Duration::from_millis(200)).await;
  assert!(!running.is_finished(), "the run ended while the agency was down");

  // It comes back saying it cannot take runs yet, and then answers.
  agency.script(vec![
    Run::Refused(503, "starting"),
    Run::Refused(503, "starting"),
    Run::Answered("the translation after the restart".into()),
  ]);
  agency.start_again().await;

  let run = timeout(BOUND, running).await.unwrap().unwrap().unwrap();

  assert_eq!(run.text, "the translation after the restart");
  assert_eq!(agency.asked(), 4);
}

/// The service's settings and the stand-ins they name, and the service started on them as a process of its own.
struct Deployment {
  scratch: Scratch,
  folder: tempfile::TempDir,
  listen: String,
  _units: [Stub; 3],
}

impl Deployment {
  async fn new(agency: &StandInAgency) -> Deployment {
    let scratch = Scratch::new().await;
    let folder = tempfile::tempdir().unwrap();
    let env = folder.path().join("env");
    let units = [Stub::start().await, Stub::start().await, Stub::start().await];
    let listen = {
      let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
      free.local_addr().unwrap().to_string()
    };

    std::fs::create_dir_all(&env).unwrap();
    std::fs::create_dir_all(folder.path().join("sessions")).unwrap();

    for (name, token) in [
      ("gate.token", TOKEN),
      ("agency.token", "the-agency-token"),
      ("brain.token", "the-brain-token"),
      ("receiver.token", "the-receiver-token"),
      ("gateway.key", "the-gateway-key"),
    ] {
      std::fs::write(env.join(name), token).unwrap();
    }

    let settings = format!(
      r#"listen = "{listen}"
address = "http://{listen}"
token_file = "gate.token"
database = "{database}"
data_root = "{root}"
chat_agent = "the-chat-agent"
session_folder = "{sessions}"

[agency]
address = "{agency}"
token_file = "agency.token"

[brain]
address = "{brain}"
token_file = "brain.token"

[receiver]
address = "{receiver}"
token_file = "receiver.token"

[gateway]
address = "{gateway}"
key_file = "gateway.key"
"#,
      database = scratch.address(),
      root = folder.path().display(),
      sessions = folder.path().join("sessions").display(),
      agency = agency.address(),
      brain = units[0].address,
      receiver = units[1].address,
      gateway = units[2].address,
    );

    std::fs::write(folder.path().join("settings.toml"), settings).unwrap();

    Deployment {
      scratch,
      folder,
      listen,
      _units: units,
    }
  }

  fn address(&self) -> String {
    format!("http://{}", self.listen)
  }

  fn log(&self) -> PathBuf {
    self.folder.path().join("gate-server.log")
  }

  /// The service started and waited for until it answers ready.
  async fn start(&self) -> Gate {
    let log = std::fs::OpenOptions::new().create(true).append(true).open(self.log()).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_gate-server"))
      .arg(self.folder.path().join("settings.toml"))
      .stdin(Stdio::null())
      .stdout(log.try_clone().unwrap())
      .stderr(log)
      .kill_on_drop(true)
      .spawn()
      .unwrap();
    let client = reqwest::Client::new();
    let health = format!("{}/health", self.address());
    let ready = until(|| async {
      match client.get(&health).bearer_auth(TOKEN).send().await {
        Ok(answer) => answer.json::<Value>().await.is_ok_and(|body| body["ready"] == true),
        Err(_) => false,
      }
    })
    .await;

    assert!(ready, "the service never answered ready: {}", read(&self.log()));
    Gate { child }
  }

  async fn written(&self) -> Vec<String> {
    self
      .scratch
      .texts(
        r#"SELECT run || ':' || event FROM gate_roads WHERE event IS NOT NULL ORDER BY event"#,
        vec![],
      )
      .await
  }
}

fn read(path: &Path) -> String {
  std::fs::read_to_string(path).unwrap_or_default()
}

/// The service as a process of its own, killed if the test lets it go still running.
struct Gate {
  child: Child,
}

impl Gate {
  /// SIGTERM sent, as the unit's stop sends it.
  fn terminate(&self) {
    let pid = self.child.id().expect("the service is running").to_string();
    let sent = std::process::Command::new("kill").args(["-TERM", &pid]).status().unwrap();

    assert!(sent.success());
  }

  /// How the process ended, waited for `BOUND` at most.
  async fn ended(&mut self) -> ExitStatus {
    timeout(BOUND, self.child.wait()).await.expect("the service ended").unwrap()
  }
}

#[tokio::test]
async fn the_gate_stopped_and_started_reads_the_agencys_roads_on_from_the_last_it_wrote() {
  let agency = StandInAgency::start().await;
  let deployment = Deployment::new(&agency).await;
  let mut gate = deployment.start().await;

  assert!(until(|| async { agency.opened().len() == 1 }).await, "{}", read(&deployment.log()));
  agency.publish_road(1, ROOM, "turn:1");
  assert!(
    until(|| async { deployment.written().await.len() == 1 }).await,
    "{}",
    read(&deployment.log())
  );

  gate.terminate();
  assert!(gate.ended().await.success(), "{}", read(&deployment.log()));

  // Turns end while the gate is down; the agency keeps their roads.
  agency.publish_road(2, ROOM, "turn:2");
  agency.publish_road(3, ROOM, "turn:3");

  let mut gate = deployment.start().await;

  assert!(
    until(|| async { deployment.written().await.len() == 3 }).await,
    "{}",
    read(&deployment.log())
  );
  assert_eq!(agency.opened(), [None, Some("1".to_owned())]);
  assert_eq!(deployment.written().await, ["turn:1:1", "turn:2:2", "turn:3:3"]);

  gate.terminate();
  assert!(gate.ended().await.success());
}

#[tokio::test]
async fn a_gate_stopped_with_a_call_in_hand_tells_its_stream_takes_no_new_call_and_answers_it() {
  let agency = StandInAgency::start().await;
  let deployment = Deployment::new(&agency).await;
  let mut gate = deployment.start().await;
  let client = reqwest::Client::new();
  let events = client
    .get(format!("{}/events", deployment.address()))
    .bearer_auth(TOKEN)
    .send()
    .await
    .unwrap();

  agency.script(vec![Run::Held("Hello.".into())]);

  let translating = tokio::spawn(
    client
      .post(format!("{}/translations", deployment.address()))
      .bearer_auth(TOKEN)
      .json(&json!({ "language": "en", "originals": [GREETING] }))
      .send(),
  );

  timeout(BOUND, agency.heard()).await.unwrap();
  gate.terminate();

  let told = timeout(BOUND, events.text()).await.unwrap().unwrap();

  assert_eq!(told.trim(), "event: stopping\ndata: {}");
  assert!(
    until(|| async { TcpStream::connect(&deployment.listen).await.is_err() }).await,
    "the stopping service still took a connection"
  );

  agency.release();

  let answered = timeout(BOUND, translating).await.unwrap().unwrap().unwrap();
  let status = answered.status();
  let body: Value = answered.json().await.unwrap();

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body["readings"][0]["text"], "Hello.", "{body}");
  assert!(gate.ended().await.success(), "{}", read(&deployment.log()));
}
