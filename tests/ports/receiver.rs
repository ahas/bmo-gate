//! The receiver port: each room fact's path and body, its answer read, and the owner notice's code carried
//! beside its fields.

use axum::http::Method;
use gate_ports::receiver::{HttpReceiver, Name, OwnerSpoke, Receiver, Roads};
use serde_json::{Map, json};

use crate::peer;
use crate::stub::Stub;

#[tokio::test]
async fn every_room_fact_is_asked_by_its_path_and_read_back() {
  let stub = Stub::start().await;
  let receiver = HttpReceiver::new(peer(&stub, "receiver-token"));

  stub.answer(
    Method::POST,
    "/rooms/titles",
    200,
    json!({ "rooms": [{ "chatId": 7, "title": "A room", "senders": [5, 6] }] }),
  );
  stub.answer(Method::POST, "/rooms/roads", 200, json!({ "kind": "group", "oneToOne": false }));
  stub.answer(Method::POST, "/rooms/spoke-between", 200, json!({ "spoke": true }));
  stub.answer(Method::POST, "/rooms/owner-spoke", 200, json!({ "owner": true, "spoke": false }));
  stub.answer(
    Method::POST,
    "/people/names",
    200,
    json!({ "names": [{ "person": 5, "name": "Someone" }, { "person": 6, "name": null }] }),
  );
  stub.answer(Method::POST, "/promises/waits", 200, json!({ "waits": true }));

  let titles = receiver.titles().await.unwrap();
  let roads = receiver.roads(7).await.unwrap();
  let spoke = receiver.spoke_between(7, 5, 100, 200).await.unwrap();
  let owner = receiver.owner_spoke(7, 5, 300, 60).await.unwrap();
  let names = receiver.names(&[5, 6]).await.unwrap();
  let waits = receiver.waits("once the build is done").await.unwrap();

  assert_eq!(titles[0].senders, vec![5, 6]);
  assert_eq!(
    roads,
    Roads {
      kind: "group".into(),
      one_to_one: false
    }
  );
  assert!(spoke);
  assert_eq!(
    owner,
    OwnerSpoke {
      owner: true,
      spoke: false
    }
  );
  assert_eq!(
    names[1],
    Name {
      person: 6,
      name: None
    }
  );
  assert!(waits);

  assert_eq!(stub.one("/rooms/roads").json(), json!({ "chatId": 7 }));
  assert_eq!(
    stub.one("/rooms/spoke-between").json(),
    json!({ "chatId": 7, "person": 5, "from": 100, "to": 200 })
  );
  assert_eq!(
    stub.one("/rooms/owner-spoke").json(),
    json!({ "chatId": 7, "person": 5, "before": 300, "seconds": 60 })
  );
  assert_eq!(stub.one("/people/names").json(), json!({ "people": [5, 6] }));
  assert_eq!(stub.one("/promises/waits").json(), json!({ "text": "once the build is done" }));
  assert_eq!(stub.one("/rooms/titles").bearer().as_deref(), Some("receiver-token"));
}

#[tokio::test]
async fn an_owner_notice_carries_its_code_beside_its_fields() {
  let stub = Stub::start().await;
  let receiver = HttpReceiver::new(peer(&stub, "t"));
  let mut fields = Map::new();

  fields.insert("row".into(), json!(41));
  fields.insert("stage".into(), json!("library-knowledge"));
  stub.answer(Method::POST, "/owner/notice", 200, json!({ "ok": true }));

  receiver.owner_notice("attachment-alarm", &fields).await.unwrap();

  assert_eq!(
    stub.one("/owner/notice").json(),
    json!({ "code": "attachment-alarm", "row": 41, "stage": "library-knowledge" })
  );
}
