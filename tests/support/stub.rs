//! A stand-in unit on the loopback: it answers each method and path the answer a test hands it, and keeps
//! every request it was sent — its method, path, query, bearer, headers and body — for the test to read back.
//! A path it was handed nothing for answers 404 `route_absent`.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;

/// One request the stand-in was sent.
#[derive(Clone, Debug)]
pub struct Seen {
  pub method: Method,
  pub path: String,
  pub query: Option<String>,
  pub headers: HeaderMap,
  pub body: String,
}

impl Seen {
  /// The body read as JSON.
  pub fn json(&self) -> Value {
    serde_json::from_str(&self.body).expect("the request's body is JSON")
  }

  /// The bearer the request presented, where it presented one.
  pub fn bearer(&self) -> Option<String> {
    self
      .headers
      .get(header::AUTHORIZATION)
      .and_then(|value| value.to_str().ok())
      .and_then(|value| value.strip_prefix("Bearer "))
      .map(str::to_owned)
  }

  pub fn header(&self, name: &str) -> Option<String> {
    self.headers.get(name).and_then(|value| value.to_str().ok()).map(str::to_owned)
  }
}

#[derive(Clone)]
struct Canned {
  status: StatusCode,
  kind: &'static str,
  body: String,
}

#[derive(Clone, Default)]
struct Shared {
  answers: Arc<Mutex<HashMap<(Method, String), Canned>>>,
  seen: Arc<Mutex<Vec<Seen>>>,
}

/// A stand-in unit listening on the loopback.
pub struct Stub {
  pub address: String,
  shared: Shared,
}

async fn answer(State(shared): State<Shared>, request: Request) -> Response {
  let (parts, body) = request.into_parts();
  let body = to_bytes(body, usize::MAX).await.unwrap_or_default();
  let path = parts.uri.path().to_owned();

  shared.seen.lock().unwrap().push(Seen {
    method: parts.method.clone(),
    path: path.clone(),
    query: parts.uri.query().map(str::to_owned),
    headers: parts.headers.clone(),
    body: String::from_utf8_lossy(&body).into_owned(),
  });

  let canned = shared.answers.lock().unwrap().get(&(parts.method, path)).cloned();

  match canned {
    Some(canned) => {
      (canned.status, [(header::CONTENT_TYPE, canned.kind)], Body::from(canned.body)).into_response()
    }
    None => (
      StatusCode::NOT_FOUND,
      [(header::CONTENT_TYPE, "application/json")],
      r#"{"error":"no route answers this","code":"route_absent"}"#,
    )
      .into_response(),
  }
}

impl Stub {
  /// A stand-in listening on a port the system chooses.
  pub async fn start() -> Stub {
    let shared = Shared::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(answer).with_state(shared.clone());

    tokio::spawn(async move {
      axum::serve(listener, app).await.unwrap();
    });

    Stub { address, shared }
  }

  /// A JSON answer to a method and path.
  pub fn answer(&self, method: Method, path: &str, status: u16, body: Value) {
    self.canned(method, path, status, "application/json", body.to_string());
  }

  /// An answer of any kind to a method and path.
  pub fn canned(&self, method: Method, path: &str, status: u16, kind: &'static str, body: String) {
    self.shared.answers.lock().unwrap().insert(
      (method, path.to_owned()),
      Canned {
        status: StatusCode::from_u16(status).unwrap(),
        kind,
        body,
      },
    );
  }

  /// Every request the stand-in was sent, in order.
  pub fn seen(&self) -> Vec<Seen> {
    self.shared.seen.lock().unwrap().clone()
  }

  /// The one request sent to a path.
  pub fn one(&self, path: &str) -> Seen {
    let seen: Vec<Seen> = self.seen().into_iter().filter(|seen| seen.path == path).collect();

    assert_eq!(seen.len(), 1, "requests to {path}: {seen:?}");
    seen.into_iter().next().unwrap()
  }
}
