//! The arbiter port: a placement's lines read to how they ended, and a description written whole.

use axum::http::Method;
use gate_ports::arbiter::{Arbiter, Ending, HttpArbiter, placed};
use serde_json::{Map, json};

use crate::peer;
use crate::stub::Stub;

#[test]
fn a_placements_last_line_says_how_it_ended() {
  assert_eq!(placed("installing\ncarried\n== done").ended, Ending::Done);
  assert_eq!(placed("installing\n== done").lines, vec!["installing"]);
  assert_eq!(
    placed("installing\n== failed: the engine did not answer").ended,
    Ending::Failed("the engine did not answer".into())
  );
  assert_eq!(placed("installing\ncarried").ended, Ending::Cut);
  assert_eq!(placed("installing\ncarried").lines.len(), 2);
}

#[tokio::test]
async fn a_service_is_placed_and_removed_and_its_units_described() {
  let stub = Stub::start().await;
  let arbiter = HttpArbiter::new(peer(&stub, "t"));
  let mut units = Map::new();

  units.insert("laya/engine".into(), json!({ "blocks": null, "output": true }));
  stub.canned(Method::POST, "/place", 200, "text/plain", "standing the service\n== done\n".into());
  stub.canned(
    Method::POST,
    "/remove",
    200,
    "text/plain",
    "stopping\n== failed: the node did not answer\n".into(),
  );
  stub.canned(Method::PUT, "/descriptions/laya", 204, "application/json", String::new());

  let placed = arbiter.place("laya", "a-node").await.unwrap();
  let removed = arbiter.remove("laya", "a-node").await.unwrap();
  arbiter.describe("laya", &units).await.unwrap();

  assert_eq!(placed.ended, Ending::Done);
  assert_eq!(removed.ended, Ending::Failed("the node did not answer".into()));
  assert_eq!(stub.one("/place").json(), json!({ "service": "laya", "node": "a-node" }));
  assert_eq!(
    stub.one("/descriptions/laya").json(),
    json!({ "units": { "laya/engine": { "blocks": null, "output": true } } })
  );
}

#[tokio::test]
async fn a_request_the_master_cannot_read_is_a_refusal() {
  let stub = Stub::start().await;

  stub.canned(Method::POST, "/place", 422, "text/plain", "no such service".into());

  assert!(HttpArbiter::new(peer(&stub, "t")).place("laya", "a-node").await.is_err());
}
