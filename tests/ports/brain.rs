//! The brain port: every call's path and camelCase body, and every answer read, a refusal answered as an
//! answer among them.

use axum::http::Method;
use gate_ports::brain::{Brain, Event, Hit, HttpBrain, Reply};
use serde_json::{Value, json};

use crate::peer;
use crate::stub::Stub;

fn row(slug: &str) -> Value {
  json!({
    "id": 4, "agent": "chat-agent", "slug": slug, "type": "state", "chatId": 7, "reach": "room",
    "condition": "", "action": "say hello", "forUser": null, "messageId": 11, "todoId": null, "setBy": 1,
    "setAt": 100, "active": true, "lastHitAt": null, "hits": 0, "doneAt": null, "doneText": null,
    "downReason": null, "downAt": null, "candidateWhy": null, "candidateAt": null,
    "event": { "kind": "deployed", "item": null }, "eventMetAt": null, "movedAt": null
  })
}

fn fragment() -> Value {
  json!({
    "kind": "room-rule", "chatId": 7, "owner": null, "agent": "chat-agent", "allAgents": false, "slug": "quiet",
    "title": "Quiet hours", "path": "rooms/7/rules/quiet.md", "scope": null, "position": 1, "active": true,
    "lastHitAt": null, "hits": 3, "setBy": null, "setAt": 9, "hand": null, "handAt": null,
    "keywords": ["quiet"], "items": [12], "writtenOn": "2026-10-01", "confirmedOn": null, "status": "open",
    "bodyHash": "h"
  })
}

#[tokio::test]
async fn the_memory_routes_send_the_agent_and_the_room_and_read_whole_rows() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "brain-token"));

  stub.answer(Method::POST, "/memory/standing", 200, json!({ "rows": [row("standing")] }));
  stub.answer(
    Method::POST,
    "/memory/conditions",
    200,
    json!({ "rows": [{ "slug": "c", "condition": "when x", "action": "do y" }] }),
  );
  stub.answer(Method::POST, "/memory/matched", 200, json!({ "ok": true }));
  stub.answer(Method::POST, "/memory/events", 200, json!({ "rows": [row("woken")] }));

  let standing = brain.standing("chat-agent", 7).await.unwrap();
  let conditions = brain.conditions("chat-agent", 7).await.unwrap();
  brain.matched("chat-agent", 7, &["c".to_owned()], &[]).await.unwrap();
  let events = [Event {
    kind: "job-ended".into(),
    item: Some(12),
  }];
  let woken = brain.woken("chat-agent", 7, &events).await.unwrap();

  assert_eq!(standing[0].slug, "standing");
  assert_eq!(standing[0].kind, "state");
  assert_eq!(
    standing[0].event,
    Some(Event {
      kind: "deployed".into(),
      item: None
    })
  );
  assert_eq!(conditions[0].condition, "when x");
  assert_eq!(woken[0].slug, "woken");

  assert_eq!(stub.one("/memory/standing").json(), json!({ "agent": "chat-agent", "chatId": 7 }));
  assert_eq!(stub.one("/memory/standing").bearer().as_deref(), Some("brain-token"));
  assert_eq!(
    stub.one("/memory/matched").json(),
    json!({ "agent": "chat-agent", "chatId": 7, "matched": ["c"], "spent": [] })
  );
  assert_eq!(
    stub.one("/memory/events").json(),
    json!({ "agent": "chat-agent", "chatId": 7, "events": [{ "kind": "job-ended", "item": 12 }] })
  );
}

#[tokio::test]
async fn the_fragment_routes_offer_by_kind_and_hand_back_what_attached() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::POST, "/fragments/offer", 200, json!({ "fragments": [fragment()] }));
  stub.answer(Method::POST, "/fragments/hits", 200, json!({ "ok": true }));

  let offered = brain.offered("chat-agent", 7, &["room-rule".to_owned()]).await.unwrap();
  let attached = [Hit {
    kind: "room-rule".into(),
    chat_id: Some(7),
    owner: None,
    slug: "quiet".into(),
  }];
  brain.hits("chat-agent", 7, &attached).await.unwrap();

  assert_eq!(offered[0].slug, "quiet");
  assert_eq!(offered[0].items, vec![12]);
  assert_eq!(
    stub.one("/fragments/offer").json(),
    json!({ "agent": "chat-agent", "chatId": 7, "kinds": ["room-rule"] })
  );
  assert_eq!(
    stub.one("/fragments/hits").json(),
    json!({ "agent": "chat-agent", "chatId": 7, "attached": [{ "kind": "room-rule", "chatId": 7, "owner": null, "slug": "quiet" }] })
  );
}

#[tokio::test]
async fn a_read_the_brain_refuses_comes_back_as_its_refusal_not_a_failure() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(
    Method::POST,
    "/knowledge/read",
    200,
    json!({ "answered": false, "refusal": { "code": "out-of-room", "message": "Not this room's.", "slugs": ["far"] } }),
  );

  let read = brain.knowledge("chat-agent", 7, &["far".to_owned()]).await.unwrap();

  match read {
    Reply::Refused(refusal) => {
      assert_eq!(refusal.code, "out-of-room");
      assert_eq!(refusal.fields["slugs"], json!(["far"]));
    }
    Reply::Answered(documents) => panic!("answered {documents:?}"),
  }
  assert_eq!(
    stub.one("/knowledge/read").json(),
    json!({ "agent": "chat-agent", "chatId": 7, "slugs": ["far"] })
  );
}

#[tokio::test]
async fn the_document_reads_answer_their_documents_sheets_and_pieces() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(
    Method::POST,
    "/knowledge/read",
    200,
    json!({ "documents": [{ "slug": "k", "path": "knowledge/k.md", "text": "a fact", "version": "v1" }] }),
  );
  stub.answer(
    Method::POST,
    "/people/read",
    200,
    json!({
      "sheets": [{ "person": 5, "part": "common", "path": "people/5/sheet.md", "text": "a sheet", "version": "v2" }],
      "pieces": [{ "slug": "p", "path": "people/5/p.md", "text": "a piece", "version": "v3", "owner": 5 }]
    }),
  );

  let documents = brain.knowledge("chat-agent", 7, &["k".to_owned()]).await.unwrap();
  let people = brain.people("chat-agent", 7, &[5], &["p".to_owned()]).await.unwrap();

  assert!(matches!(documents, Reply::Answered(ref read) if read[0].text == "a fact"));
  match people {
    Reply::Answered(people) => {
      assert_eq!(people.sheets[0].part, "common");
      assert_eq!(people.pieces[0].owner, Some(5));
    }
    Reply::Refused(refusal) => panic!("refused {refusal:?}"),
  }
  assert_eq!(
    stub.one("/people/read").json(),
    json!({ "agent": "chat-agent", "chatId": 7, "senders": [5], "slugs": ["p"] })
  );
}

#[tokio::test]
async fn the_room_rules_the_loads_and_a_forgotten_room_go_by_their_own_keys() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(
    Method::POST,
    "/room-rules/read",
    200,
    json!({ "rules": [{ "id": "r1", "subject": 9, "text": "may ask for songs" }] }),
  );
  stub.answer(
    Method::POST,
    "/sessions/loads",
    200,
    json!({ "loads": [{ "path": "knowledge/k.md", "version": "v1" }] }),
  );
  stub.answer(Method::POST, "/rooms/forgotten", 200, json!({ "ok": true }));

  let rules = brain.room_rules(7).await.unwrap();
  let loads = brain.loads("session-1").await.unwrap();
  brain.forgotten(7).await.unwrap();

  assert_eq!(rules[0].subject, 9);
  assert_eq!(loads[0].version, "v1");
  assert_eq!(stub.one("/room-rules/read").json(), json!({ "chatId": 7 }));
  assert_eq!(stub.one("/sessions/loads").json(), json!({ "session": "session-1" }));
  assert_eq!(stub.one("/rooms/forgotten").json(), json!({ "chatId": 7 }));
}
