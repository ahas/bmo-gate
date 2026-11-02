//! What every port shares: the addresses it takes, the path a call goes to, the bearer, a refusal read as the
//! unit gave it, and a unit that refuses the connection.

use axum::http::Method;
use gate_codes::Code;
use gate_ports::http::Caller;
use gate_ports::{Peer, PortError};
use serde_json::{Value, json};

use super::peer;
use crate::support::stub::Stub;

#[test]
fn an_address_that_is_no_plain_http_one_is_refused_when_the_peer_is_made() {
  for address in ["https://example-host/", "ftp://example-host/", "not an address", "mailto:someone"] {
    assert!(
      matches!(Peer::new(address, None), Err(PortError::NotAnAddress { .. })),
      "{address} was taken"
    );
  }
  assert!(Peer::new("http://example-host:7000/base/", None).is_ok());
}

#[test]
fn a_path_is_built_from_its_segments_each_encoded_on_the_base() {
  let caller = Caller::new("a unit", Peer::new("http://example-host:7000/base/", None).unwrap());

  assert_eq!(caller.url(&["rooms", "titles"]).as_str(), "http://example-host:7000/base/rooms/titles");
  assert_eq!(
    caller.url(&["descriptions", "a service"]).as_str(),
    "http://example-host:7000/base/descriptions/a%20service"
  );
}

#[tokio::test]
async fn a_call_presents_the_peers_token_and_reads_its_answer() {
  let stub = Stub::start().await;
  let caller = Caller::new("a unit", peer(&stub, "the-token"));

  stub.answer(Method::GET, "/agents", 200, json!({ "agents": [] }));

  let answer: Value = caller.get("agents", &["agents"], &[]).await.unwrap();

  assert_eq!(answer, json!({ "agents": [] }));
  assert_eq!(stub.one("/agents").bearer().as_deref(), Some("the-token"));
}

#[tokio::test]
async fn a_refusal_is_handed_on_with_its_status_code_and_sentence() {
  let stub = Stub::start().await;
  let caller = Caller::new("a unit", peer(&stub, "t"));

  stub.answer(Method::POST, "/x", 409, json!({ "error": "the run was stopped", "code": "stopped" }));

  let refused = caller.post::<_, Value>("a call", &["x"], &json!({})).await.unwrap_err();

  assert_eq!(
    refused,
    PortError::Refused {
      unit: "a unit",
      call: "a call",
      status: 409,
      code: "stopped".into(),
      error: "the run was stopped".into()
    }
  );
  assert_eq!(refused.code(), Code::UpstreamFailed);
  assert_eq!(refused.refused_with(), Some("stopped"));
}

#[tokio::test]
async fn a_body_that_reads_as_neither_shape_is_malformed() {
  let stub = Stub::start().await;
  let caller = Caller::new("a unit", peer(&stub, "t"));

  stub.answer(Method::GET, "/agents", 200, json!({ "something": "else" }));

  #[derive(Debug, serde::Deserialize)]
  struct Agents {
    #[allow(dead_code)]
    agents: Vec<Value>,
  }

  let failed = caller.get::<Agents>("agents", &["agents"], &[]).await.unwrap_err();

  assert!(matches!(failed, PortError::Malformed { status: 200, .. }), "{failed:?}");
}

#[tokio::test]
async fn a_refused_connection_ends_the_call_and_is_offered_no_more() {
  // A port nothing listens on: bound, its address read, and let go.
  let address = {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://{}", listener.local_addr().unwrap())
  };
  let peer = Peer::new(&address, None).unwrap();

  let failed = Caller::new("a unit", peer).get::<Value>("a read", &["x"], &[]).await.unwrap_err();

  assert!(matches!(failed, PortError::Unreachable { .. }), "{failed:?}");
}
