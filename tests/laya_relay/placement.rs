//! The placement as the relay reads it: the nodes in their order with the installers' own fields allowed, and a
//! placement the installers would refuse refused.

use laya_relay::placement::{ServiceNode, nodes_of};
use serde_json::{Value, json};

fn read(value: Value) -> Result<Vec<ServiceNode>, String> {
  nodes_of(&value)
}

#[test]
fn the_nodes_are_read_in_their_order_with_the_installers_own_fields_allowed() {
  let nodes = read(json!({ "nodes": [
    { "node": "node-a", "listen": "127.0.0.1:18011", "cardModels": 2 },
    { "node": "node-b", "listen": "127.0.0.1:18012", "hostCopy": "mapped" },
  ]}))
  .unwrap();

  assert_eq!(nodes.iter().map(|one| one.node.as_str()).collect::<Vec<_>>(), ["node-a", "node-b"]);
  assert_eq!(nodes[1].listen, "127.0.0.1:18012");
}

#[test]
fn a_placement_the_installers_would_refuse_is_refused() {
  let refused = |value: Value| read(value).unwrap_err();

  assert_eq!(refused(json!({ "nodes": [] })), "nodes is empty");
  assert_eq!(refused(json!([])), "the file is not an object");
  assert!(
    refused(json!({ "nodes": [{ "node": "Node-B", "listen": "127.0.0.1:18011" }] }))
      .contains("registered node's name")
  );
  assert!(
    refused(json!({ "nodes": [{ "node": "node-b", "listen": "0.0.0.0:18011" }] }))
      .contains("not of the shape")
  );
  assert!(
    refused(json!({ "nodes": [{ "node": "node-b", "listen": "127.0.0.1:18010" }] }))
      .contains("relay's own listen")
  );
  assert!(
    refused(json!({ "nodes": [{ "node": "node-b", "listen": "127.0.0.1:18011", "cardModels": 0 }] }))
      .contains("whole number")
  );
  assert!(
    refused(json!({ "nodes": [{ "node": "node-b", "listen": "127.0.0.1:18011", "hostCopy": "x" }] }))
      .contains("hostCopy")
  );
  assert_eq!(
    refused(json!({ "nodes": [
      { "node": "node-b", "listen": "127.0.0.1:18011" },
      { "node": "node-b", "listen": "127.0.0.1:18012" },
    ]})),
    "node node-b stands twice"
  );
}
