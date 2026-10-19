//! The relay's asking: a node whose health did not answer is asked last, and a call reaches a node without the hop's
//! own headers and named for the node.

use std::collections::HashSet;

use axum::body::Bytes;
use axum::http::{HeaderMap, HeaderValue, Method, header};
use laya_relay::placement::ServiceNode;
use laya_relay::relay::{asking_order, node_request};

fn nodes() -> Vec<ServiceNode> {
  ["node-a", "node-b", "node-c"]
    .iter()
    .enumerate()
    .map(|(at, node)| ServiceNode {
      node: (*node).to_owned(),
      listen: format!("127.0.0.1:{}", 18011 + at),
    })
    .collect()
}

fn names(order: Vec<ServiceNode>) -> Vec<String> {
  order.into_iter().map(|one| one.node).collect()
}

#[test]
fn a_node_whose_health_did_not_answer_is_asked_after_the_ones_that_did() {
  let down: HashSet<String> = ["node-a".to_owned()].into();

  assert_eq!(names(asking_order(&nodes(), &down)), ["node-b", "node-c", "node-a"]);
  assert_eq!(names(asking_order(&nodes(), &HashSet::new())), ["node-a", "node-b", "node-c"]);
}

#[test]
fn a_call_reaches_a_node_without_the_hop_headers_and_named_for_the_node() {
  let mut headers = HeaderMap::new();

  headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:18010"));
  headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
  headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
  headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer k"));

  let request =
    node_request(&Method::POST, "/decide?x=1", "127.0.0.1:18011", &headers, &Bytes::from_static(b"{}"));

  assert_eq!(request.uri(), "/decide?x=1");
  assert_eq!(request.headers()[header::HOST], "127.0.0.1:18011");
  assert_eq!(request.headers()[header::AUTHORIZATION], "Bearer k");
  assert_eq!(request.headers()[header::ACCEPT_ENCODING], "identity");
  assert!(request.headers().get(header::CONNECTION).is_none());
}
