//! The relay's wire contract (docs/llm-server.md, 「The relay」), asked of the command under test as a caller asks
//! it: the relay started as a process on a free port over a scratch data root, its nodes stand-in engine fronts on
//! loopback that answer as each case scripts them and keep what they were asked. The command is the repository's
//! binary, or the one `LAYA_RELAY_CONTRACT_COMMAND` names.

use std::collections::VecDeque;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};

const NEXT_WAIT_MS: u64 = 500;
const LAST_WAIT_MS: u64 = 3_000;

/// What a stand-in node does with one call.
#[derive(Clone)]
enum Act {
  Answer(u16, &'static str),
  /// Answers once the wait is over.
  Later(Duration, u16, &'static str),
  /// Never answers.
  Hang,
}

#[derive(Clone, Debug, PartialEq)]
struct Asked {
  method: String,
  target: String,
  body: String,
  auth: Option<String>,
}

#[derive(Default)]
struct Script {
  health: u16,
  acts: VecDeque<Act>,
  asked: Vec<Asked>,
  health_asked: usize,
  // Calls whose connection went away while the node still held them.
  left: usize,
}

/// A stand-in engine front: an answer per call as scripted, 200 where nothing is, and its open health.
#[derive(Clone)]
struct Node {
  name: &'static str,
  listen: String,
  script: Arc<Mutex<Script>>,
  // The socket keeping an absent node's port reserved.
  _held: Option<Arc<tokio::net::TcpSocket>>,
}

// Counts a held call as left once its handler is dropped unfinished, which is the connection closing.
struct Holding(Arc<Mutex<Script>>);

impl Drop for Holding {
  fn drop(&mut self) {
    self.0.lock().unwrap().left += 1;
  }
}

async fn node_answer(State(script): State<Arc<Mutex<Script>>>, request: Request) -> Response {
  let (parts, body) = request.into_parts();
  if parts.uri.path() == "/health" {
    let mut held = script.lock().unwrap();
    held.health_asked += 1;
    return StatusCode::from_u16(held.health).unwrap().into_response();
  }
  let body = body.collect().await.unwrap().to_bytes();
  let act = {
    let mut held = script.lock().unwrap();
    held.asked.push(Asked {
      method: parts.method.to_string(),
      target: parts.uri.to_string(),
      body: String::from_utf8_lossy(&body).into_owned(),
      auth: parts.headers.get("authorization").map(|value| value.to_str().unwrap().to_owned()),
    });
    held.acts.pop_front().unwrap_or(Act::Answer(200, r#"{"answers":{}}"#))
  };
  let (status, said) = match act {
    Act::Answer(status, said) => (status, said),
    Act::Later(wait, status, said) => {
      tokio::time::sleep(wait).await;
      (status, said)
    }
    Act::Hang => {
      let _holding = Holding(Arc::clone(&script));
      std::future::pending::<()>().await;
      unreachable!()
    }
  };
  (
    StatusCode::from_u16(status).unwrap(),
    [("content-type", "application/json"), ("x-engine", "stand-in")],
    said,
  )
    .into_response()
}

impl Node {
  async fn start(name: &'static str) -> Node {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let listen = listener.local_addr().unwrap().to_string();
    let script = Arc::new(Mutex::new(Script {
      health: 200,
      ..Script::default()
    }));
    let app = Router::new().fallback(node_answer).with_state(Arc::clone(&script));
    tokio::spawn(async move { axum::serve(listener, app).await });
    Node {
      name,
      listen,
      script,
      _held: None,
    }
  }

  /// A node in the placement with nothing listening at its address: the port held by a socket that
  /// is bound and never listens, so a connection to it is refused and no other stand-in takes it.
  fn absent(name: &'static str) -> Node {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listen = socket.local_addr().unwrap().to_string();
    Node {
      name,
      listen,
      script: Arc::default(),
      _held: Some(Arc::new(socket)),
    }
  }

  fn then(&self, act: Act) -> &Node {
    self.script.lock().unwrap().acts.push_back(act);
    self
  }

  fn set_health(&self, status: u16) {
    self.script.lock().unwrap().health = status;
  }

  fn asked(&self) -> Vec<Asked> {
    self.script.lock().unwrap().asked.clone()
  }

  fn health_asked(&self) -> usize {
    self.script.lock().unwrap().health_asked
  }

  fn left(&self) -> usize {
    self.script.lock().unwrap().left
  }
}

fn command() -> Command {
  match std::env::var("LAYA_RELAY_CONTRACT_COMMAND") {
    Ok(named) if !named.trim().is_empty() => {
      let mut words = named.split_whitespace();
      let mut command = Command::new(words.next().unwrap());
      command.args(words);
      command
    }
    _ => Command::new(env!("CARGO_BIN_EXE_laya-relay")),
  }
}

struct Relay {
  dir: tempfile::TempDir,
  child: Child,
  port: u16,
  // The placement's modification time, moved on by a second at each write so every write is seen.
  written: SystemTime,
}

impl Relay {
  async fn start(nodes: &[&Node]) -> Relay {
    Relay::start_with(nodes, LAST_WAIT_MS).await
  }

  async fn start_with(nodes: &[&Node], last_wait_ms: u64) -> Relay {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("data/placements")).unwrap();
    let written = SystemTime::now();
    write_at(&dir.path().join(PLACEMENT), &placement_of(nodes), written);
    let log = std::fs::File::create(dir.path().join("relay.log")).unwrap();
    let child = command()
      .env("BMO_DATA_DIR", dir.path().join("data"))
      // A port of its own choosing, which it names as it starts listening, so no other process can
      // take the port between its choosing and its binding.
      .env("LAYA_RELAY_LISTEN", "127.0.0.1:0")
      .env("LAYA_RELAY_NEXT_WAIT_MS", NEXT_WAIT_MS.to_string())
      .env("LAYA_RELAY_LAST_WAIT_MS", last_wait_ms.to_string())
      .env("LAYA_RELAY_PROBE_EVERY_MS", "100")
      // Long enough that a loaded machine never takes a healthy node for one that is down.
      .env("LAYA_RELAY_PROBE_WAIT_MS", "5000")
      .stdin(Stdio::null())
      .stdout(log.try_clone().unwrap())
      .stderr(log)
      .process_group(0)
      .spawn()
      .expect("the relay starts");
    let mut relay = Relay {
      dir,
      child,
      port: 0,
      written,
    };
    // The relay's own line saying where it listens: `laya-relay: listening at 127.0.0.1:<port>`.
    let ready = Instant::now() + Duration::from_secs(20);
    relay.port = loop {
      let heard = relay.log().lines().find_map(|line| {
        line.strip_prefix("laya-relay: listening at 127.0.0.1:")?.trim().parse::<u16>().ok()
      });
      if let Some(port) = heard {
        break port;
      }
      assert!(Instant::now() < ready, "the relay never listened; it said {}", relay.log());
      tokio::time::sleep(Duration::from_millis(20)).await;
    };
    relay
  }

  fn write_placement(&mut self, text: &str) {
    self.written += Duration::from_secs(1);
    write_at(&self.dir.path().join(PLACEMENT), text, self.written);
  }

  fn place(&mut self, nodes: &[&Node]) {
    self.write_placement(&placement_of(nodes));
  }

  fn log(&self) -> String {
    std::fs::read_to_string(self.dir.path().join("relay.log")).unwrap_or_default()
  }

  fn said(&self, line: &str) -> usize {
    self.log().matches(line).count()
  }

  async fn until_said(&self, line: &str) {
    until(&format!("the relay to say {line:?}"), || self.said(line) > 0).await;
  }

  async fn call(&self, method: &str, target: &str, body: &str) -> (u16, HeaderMap, String) {
    let stream = TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
    let (mut sender, connection) =
      hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.unwrap();
    tokio::spawn(connection);
    let request = hyper::Request::builder()
      .method(method)
      .uri(target)
      .header("host", format!("127.0.0.1:{}", self.port))
      .header("authorization", "Bearer secret-key")
      .header("content-type", "application/json")
      .body(Full::new(Bytes::from(body.to_owned())))
      .unwrap();
    let answer = sender.send_request(request).await.unwrap();
    let status = answer.status().as_u16();
    let headers = answer.headers().clone();
    let body = answer.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8_lossy(&body).into_owned())
  }

  async fn decide(&self) -> (u16, HeaderMap, String) {
    self.call("POST", "/decide", r#"{"gate":"room-rules"}"#).await
  }
}

impl Drop for Relay {
  fn drop(&mut self) {
    unsafe {
      libc::kill(-(self.child.id() as i32), libc::SIGKILL);
    }
    let _ = self.child.wait();
  }
}

const PLACEMENT: &str = "data/placements/laya-service.json";

fn placement_of(nodes: &[&Node]) -> String {
  let listed: Vec<Value> =
    nodes.iter().map(|one| json!({ "node": one.name, "listen": one.listen })).collect();
  json!({ "nodes": listed }).to_string()
}

// A file written with the modification time given, so each write is seen as a change.
fn write_at(path: &Path, text: &str, modified: SystemTime) {
  std::fs::write(path, text).unwrap();
  std::fs::File::options().write(true).open(path).unwrap().set_modified(modified).unwrap();
}

async fn until(what: &str, holds: impl Fn() -> bool) {
  let bound = Instant::now() + Duration::from_secs(15);
  while !holds() {
    assert!(Instant::now() < bound, "waited in vain for {what}");
    tokio::time::sleep(Duration::from_millis(20)).await;
  }
}

fn node_of(headers: &HeaderMap) -> &str {
  headers.get("x-laya-node").map_or("", |value| value.to_str().unwrap())
}

#[tokio::test]
async fn a_call_is_answered_by_the_first_node_which_the_answer_names() {
  let (first, second) = (Node::start("node-a").await, Node::start("node-b").await);
  first.then(Act::Answer(200, r#"{"answers":{"room-rules":"ok"}}"#));
  let relay = Relay::start(&[&first, &second]).await;

  let (status, headers, body) = relay.call("POST", "/decide?trace=1", r#"{"gate":"room-rules"}"#).await;

  assert_eq!(status, 200);
  assert_eq!(node_of(&headers), "node-a");
  assert_eq!(headers.get("x-engine").unwrap(), "stand-in");
  assert_eq!(body, r#"{"answers":{"room-rules":"ok"}}"#);
  assert_eq!(
    first.asked(),
    [Asked {
      method: "POST".into(),
      target: "/decide?trace=1".into(),
      body: r#"{"gate":"room-rules"}"#.into(),
      auth: Some("Bearer secret-key".into()),
    }]
  );
  assert!(second.asked().is_empty());
  // Nothing of a call is logged: neither its body nor its key.
  let log = relay.log();
  assert!(
    !log.contains("room-rules") && !log.contains("secret-key"),
    "the relay logged a call: {log}"
  );
}

#[tokio::test]
async fn a_call_moves_on_past_a_busy_card_sending_the_same_call_again() {
  let (first, second) = (Node::start("node-a").await, Node::start("node-b").await);
  first.then(Act::Answer(503, "card busy"));
  second.then(Act::Answer(200, r#"{"answers":{"q":1}}"#));
  let relay = Relay::start(&[&first, &second]).await;

  let (status, headers, body) = relay.decide().await;

  assert_eq!((status, node_of(&headers), body.as_str()), (200, "node-b", r#"{"answers":{"q":1}}"#));
  let bodies: Vec<String> = first.asked().into_iter().chain(second.asked()).map(|one| one.body).collect();
  assert_eq!(bodies, [r#"{"gate":"room-rules"}"#, r#"{"gate":"room-rules"}"#]);
}

#[tokio::test]
async fn a_call_moves_on_past_a_node_it_cannot_reach() {
  let (first, second) = (Node::absent("node-a"), Node::start("node-b").await);
  let relay = Relay::start(&[&first, &second]).await;

  let (status, headers, _) = relay.decide().await;

  assert_eq!((status, node_of(&headers)), (200, "node-b"));
  assert_eq!(second.asked().len(), 1);
}

#[tokio::test]
async fn a_call_moves_on_past_a_node_that_does_not_answer_in_time_and_the_last_is_given_longer() {
  let (first, second) = (Node::start("node-a").await, Node::start("node-b").await);
  first.then(Act::Hang);
  // Past the wait a node before the last is given, within the last one's.
  second.then(Act::Later(Duration::from_millis(NEXT_WAIT_MS * 2), 200, "{}"));
  let relay = Relay::start(&[&first, &second]).await;

  let started = Instant::now();
  let (status, headers, _) = relay.decide().await;

  assert_eq!((status, node_of(&headers)), (200, "node-b"));
  assert!(started.elapsed() >= Duration::from_millis(NEXT_WAIT_MS * 3));
}

#[tokio::test]
async fn an_answer_another_node_would_give_the_same_way_comes_back_as_it_came() {
  let (first, second) = (Node::start("node-a").await, Node::start("node-b").await);
  let relay = Relay::start(&[&first, &second]).await;

  for status in [400, 401, 404, 500, 504] {
    first.then(Act::Answer(status, "no"));
    let (answered, headers, body) = relay.decide().await;
    assert_eq!((answered, node_of(&headers), body.as_str()), (status, "node-a", "no"));
  }
  // A stream asked of the service is the front's 400, handed back as it came.
  first.then(Act::Answer(400, r#"{"error":{"message":"streaming is not offered"}}"#));
  let (answered, _, body) = relay.call("POST", "/v1/chat/completions", r#"{"stream":true}"#).await;
  assert_eq!((answered, body.as_str()), (400, r#"{"error":{"message":"streaming is not offered"}}"#));
  assert_eq!(first.asked().len(), 6);
  assert!(second.asked().is_empty());
}

#[tokio::test]
async fn the_last_nodes_503_reaches_the_caller() {
  let (first, second) = (Node::start("node-a").await, Node::start("node-b").await);
  first.then(Act::Answer(503, "busy"));
  second.then(Act::Answer(503, "loading"));
  let relay = Relay::start(&[&first, &second]).await;

  let (status, headers, body) = relay.decide().await;

  assert_eq!((status, node_of(&headers), body.as_str()), (503, "node-b", "loading"));
}

#[tokio::test]
async fn a_call_no_node_took_says_why_for_each() {
  let (first, second) = (Node::start("node-a").await, Node::absent("node-b"));
  first.then(Act::Hang);
  let relay = Relay::start(&[&first, &second]).await;
  relay.until_said("node-b does not answer").await;

  let (status, headers, body) = relay.decide().await;

  assert_eq!(status, 503);
  assert_eq!(node_of(&headers), "");
  let error = serde_json::from_str::<Value>(&body).unwrap()["error"].as_str().unwrap().to_owned();
  assert_eq!(error, "No Laya node took the call: node-a: no answer within 0.5s; node-b: not reached");
}

#[tokio::test]
async fn the_probe_puts_a_node_last_and_back_saying_each_change_once() {
  let (first, second) = (Node::start("node-a").await, Node::start("node-b").await);
  first.set_health(500);
  let relay = Relay::start(&[&first, &second]).await;
  let gone = "node-a does not answer";
  let back = "node-a answers again";

  relay.until_said(gone).await;
  let seen = first.health_asked();
  until("three more probes", || first.health_asked() >= seen + 3).await;
  assert_eq!(relay.said(gone), 1);
  let (_, headers, _) = relay.decide().await;
  assert_eq!(node_of(&headers), "node-b");
  assert!(first.asked().is_empty());

  first.set_health(200);
  relay.until_said(back).await;
  let seen = first.health_asked();
  until("three more probes", || first.health_asked() >= seen + 3).await;
  assert_eq!((relay.said(gone), relay.said(back)), (1, 1));
  let (_, headers, _) = relay.decide().await;
  assert_eq!(node_of(&headers), "node-a");
}

#[tokio::test]
async fn a_changed_placement_is_read_again_with_no_restart_and_an_unreadable_one_keeps_the_last() {
  let (first, second) = (Node::start("node-a").await, Node::start("node-b").await);
  let mut relay = Relay::start(&[&first, &second]).await;
  assert_eq!(node_of(&relay.decide().await.1), "node-a");

  relay.place(&[&second, &first]);
  assert_eq!(node_of(&relay.decide().await.1), "node-b");

  relay.write_placement("{ not json");
  assert_eq!(node_of(&relay.decide().await.1), "node-b");
  assert!(
    relay.said("This reading is passed over") >= 1,
    "the relay did not say it kept the last order: {}",
    relay.log()
  );
}

#[tokio::test]
async fn a_caller_that_leaves_closes_the_call_to_the_node() {
  let node = Node::start("node-a").await;
  node.then(Act::Hang);
  // The node is given far longer than the case waits, so only the caller's leaving can end the call.
  let relay = Relay::start_with(&[&node], 60_000).await;

  let stream = TcpStream::connect(("127.0.0.1", relay.port)).await.unwrap();
  let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.unwrap();
  let driving = tokio::spawn(connection);
  let request = hyper::Request::post("/decide")
    .header("host", "127.0.0.1")
    .body(Full::new(Bytes::from_static(br#"{"gate":"room-rules"}"#)))
    .unwrap();
  let asking = tokio::spawn(async move { sender.send_request(request).await });
  until("the node to hold the call", || node.asked().len() == 1).await;

  asking.abort();
  driving.abort();

  until("the node's call to close", || node.left() == 1).await;
}

#[test]
fn a_relay_named_no_data_root_refuses_to_start() {
  let ended = command()
    .env_remove("BMO_DATA_DIR")
    .env("LAYA_RELAY_LISTEN", "127.0.0.1:0")
    .stdin(Stdio::null())
    .output()
    .expect("the relay starts");

  assert_eq!(ended.status.code(), Some(2));
  assert!(String::from_utf8_lossy(&ended.stderr).contains("--data-root or BMO_DATA_DIR"));
}
