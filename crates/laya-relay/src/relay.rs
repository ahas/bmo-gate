//! The relay's asking: each call read whole once and handed to the placement's nodes in turn until one takes it,
//! and every node's open health asked on a beat of its own so a node that is off is asked last. Every call the
//! service takes is a decision or a reading that changes nothing, so the same call sent twice is safe.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http_body_util::{BodyExt, Full};
use hyper::http::response::Parts;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

use crate::placement::{ServiceNode, Watcher};

/// The header every answer carries, naming the node that gave it.
pub const NODE_HEADER: &str = "x-laya-node";

// What one hop drops on the way to a node, and what an answer read whole no longer is.
const HOP_HEADERS: [&str; 6] =
  ["host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade"];
const ANSWER_DROPS: [&str; 5] =
  ["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"];

// The most of a call the relay reads.
const BODY_LIMIT: usize = 128 * 1024 * 1024;

/// How long each wait is.
#[derive(Clone, Copy, Debug)]
pub struct Waits {
  /// A node that is not the last: a decision takes well under a second, so only a hung tunnel meets it.
  pub next: Duration,
  /// The last node: past the front's own thirty seconds, so its 504 reaches the caller.
  pub last: Duration,
  pub probe_every: Duration,
  pub probe: Duration,
}

impl Default for Waits {
  fn default() -> Self {
    Waits {
      next: Duration::from_secs(10),
      last: Duration::from_secs(40),
      probe_every: Duration::from_secs(5),
      probe: Duration::from_secs(3),
    }
  }
}

impl Waits {
  /// The defaults, each changed where its `LAYA_RELAY_*_MS` variable names a number of milliseconds.
  pub fn from_env() -> Self {
    let named = |name: &str, default: Duration| {
      std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map_or(default, Duration::from_millis)
    };
    let default = Waits::default();

    Waits {
      next: named("LAYA_RELAY_NEXT_WAIT_MS", default.next),
      last: named("LAYA_RELAY_LAST_WAIT_MS", default.last),
      probe_every: named("LAYA_RELAY_PROBE_EVERY_MS", default.probe_every),
      probe: named("LAYA_RELAY_PROBE_WAIT_MS", default.probe),
    }
  }
}

/// The nodes in the order a call asks them: those whose last health answer was 200 first, each group in the
/// placement's order, so a node that is off costs nothing and a hung one at most one wait.
pub fn asking_order(nodes: &[ServiceNode], down: &HashSet<String>) -> Vec<ServiceNode> {
  let (up, off): (Vec<_>, Vec<_>) = nodes.iter().cloned().partition(|one| !down.contains(&one.node));

  up.into_iter().chain(off).collect()
}

/// Why a node did not take a call.
enum Missed {
  Unreached,
  Late,
}

/// The connections to the nodes, kept open between calls: a node's listen is the far end of an SSH tunnel, where
/// opening a connection costs tens of milliseconds a call would otherwise pay each time.
pub type Nodes = Client<HttpConnector, Full<Bytes>>;

/// One node asked one thing, its answer read whole within the wait. Dropping the call — the caller gone — drops
/// the connection it is on, which closes the call to the node at once.
async fn ask(
  nodes: &Nodes,
  listen: &str,
  mut request: hyper::Request<Full<Bytes>>,
  wait: Duration,
) -> Result<(Parts, Bytes), Missed> {
  let target = request.uri().path_and_query().map_or("/", |at| at.as_str());

  *request.uri_mut() = format!("http://{listen}{target}").parse().map_err(|_| Missed::Unreached)?;

  let exchange = async {
    let answer = nodes.request(request).await.map_err(|_| Missed::Unreached)?;
    let (parts, body) = answer.into_parts();
    let body = body.collect().await.map_err(|_| Missed::Unreached)?.to_bytes();

    Ok((parts, body))
  };

  tokio::time::timeout(wait, exchange).await.unwrap_or(Err(Missed::Late))
}

/// The call as one node is asked it: the hop's own headers left behind, the host the node's listen, and no answer
/// asked for in another coding, since an answer is passed back as plain bytes.
pub fn node_request(
  method: &Method,
  target: &str,
  listen: &str,
  headers: &HeaderMap,
  body: &Bytes,
) -> hyper::Request<Full<Bytes>> {
  let mut request = hyper::Request::builder().method(method.clone()).uri(target);
  let sent = request.headers_mut().expect("a request under construction has headers");

  for (name, value) in headers {
    if !HOP_HEADERS.contains(&name.as_str()) {
      sent.append(name, value.clone());
    }
  }

  sent.insert(
    header::HOST,
    HeaderValue::from_str(listen).expect("a placement's listen is a header value"),
  );
  sent.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
  request
    .body(Full::new(body.clone()))
    .expect("a request built from a received one is valid")
}

pub struct Relay {
  watcher: Watcher,
  waits: Waits,
  down: Mutex<HashSet<String>>,
  nodes: Nodes,
}

impl Relay {
  pub fn new(watcher: Watcher, waits: Waits) -> Self {
    Relay {
      watcher,
      waits,
      down: Mutex::new(HashSet::new()),
      nodes: Client::builder(TokioExecutor::new()).build_http(),
    }
  }

  /// One call, asked of each node in turn until one takes it.
  pub async fn handle(&self, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = if parts.method == Method::GET || parts.method == Method::HEAD {
      Bytes::new()
    } else {
      match axum::body::to_bytes(body, BODY_LIMIT).await {
        Ok(body) => body,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
      }
    };
    let target = parts.uri.path_and_query().map_or("/", |at| at.as_str());
    let order = asking_order(&self.watcher.nodes(), &self.down.lock().unwrap());
    let mut passed = Vec::new();

    for (index, at) in order.iter().enumerate() {
      let last = index == order.len() - 1;
      let wait = if last { self.waits.last } else { self.waits.next };
      let request = node_request(&parts.method, target, &at.listen, &parts.headers, &body);

      match ask(&self.nodes, &at.listen, request, wait).await {
        Ok((answer, bytes)) if answer.status == StatusCode::SERVICE_UNAVAILABLE && !last => {
          let said: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();

          passed.push(format!("{}: 503 {said}", at.node));
        }
        Ok((answer, bytes)) => {
          let mut kept = answer.headers;

          for name in ANSWER_DROPS {
            kept.remove(name);
          }

          kept.insert(
            HeaderName::from_static(NODE_HEADER),
            HeaderValue::from_str(&at.node).expect("a node's name is a header value"),
          );

          let mut response = Response::new(Body::from(bytes));

          *response.status_mut() = answer.status;
          *response.headers_mut() = kept;
          return response;
        }
        Err(Missed::Late) => {
          passed.push(format!("{}: no answer within {}s", at.node, wait.as_millis() as f64 / 1000.0));
        }
        Err(Missed::Unreached) => passed.push(format!("{}: not reached", at.node)),
      }
    }

    let refusal =
      serde_json::json!({ "error": format!("No Laya node took the call: {}", passed.join("; ")) });

    (
      StatusCode::SERVICE_UNAVAILABLE,
      [(header::CONTENT_TYPE, "application/json;charset=utf-8")],
      refusal.to_string(),
    )
      .into_response()
  }

  /// Every node's open health asked once; a change of a node's state is said in one line.
  pub async fn probe(&self) {
    let nodes = self.watcher.nodes();

    futures_util::future::join_all(nodes.iter().map(|at| async move {
      let request = hyper::Request::get("/health")
        .header(header::HOST, &at.listen)
        .body(Full::new(Bytes::new()))
        .expect("the health request is valid");
      let up = matches!(
        ask(&self.nodes, &at.listen, request, self.waits.probe).await,
        Ok((answer, _)) if answer.status == StatusCode::OK
      );
      let mut down = self.down.lock().unwrap();

      if up && down.remove(&at.node) {
        println!("laya-relay: {} answers again", at.node);
      } else if !up && down.insert(at.node.clone()) {
        println!("laya-relay: {} does not answer; the nodes after it are asked first", at.node);
      }
    }))
    .await;
  }
}

/// Every path of the front passed through, whatever its method.
pub fn router(relay: Arc<Relay>) -> Router {
  Router::new()
    .fallback(
      |State(relay): State<Arc<Relay>>, request: Request| async move { relay.handle(request).await },
    )
    .with_state(relay)
}

/// The probe on its beat, the first at once. Each round stands on its own, so a hung node delays no later round.
pub fn start_probes(relay: Arc<Relay>) {
  tokio::spawn(async move {
    let mut beat = tokio::time::interval(relay.waits.probe_every);

    loop {
      beat.tick().await;

      let round = Arc::clone(&relay);

      tokio::spawn(async move { round.probe().await });
    }
  });
}
