//! The brain port: every call's path, query and camelCase body, and every answer read as the brain's own
//! generic members — fragments with their old fields in `labels`, and memories with their conditions.

use axum::http::Method;
use gate_ports::brain::{Brain, Event, Hit, HttpBrain, Reply};
use serde_json::{Value, json};

use crate::peer;
use crate::stub::Stub;

fn memory() -> Value {
  json!({
    "id": 4, "scope": "bmo:room:7", "subjectKey": null, "kind": "state", "text": "a row",
    "state": "standing",
    "conditions": [{ "type": "state", "event": "job-ended:12", "reach": "room", "condition": "when x" }],
    "labels": { "slug": "c", "agent": "chat-agent", "chat_id": "7", "reach": "room", "event": "job-ended:12" },
    "matchCount": 0, "lastMatchedAt": null, "createdAt": 100, "changedAt": 100
  })
}

fn fragment() -> Value {
  json!({
    "id": 3, "key": "bmo:rooms:7:rules:quiet", "kind": "room-rule", "scope": "bmo:room:7",
    "subjectKey": null, "title": "Quiet hours", "path": "rooms/7/rules/quiet.md", "text": "quiet",
    "version": "h", "libraryName": null, "state": "active", "switchedOff": [],
    "labels": {
      "kind": "room-rule", "slug": "quiet", "agent": "chat-agent", "chat_id": "7", "position": "1",
      "keywords": "[\"quiet\"]", "items": "[12]", "status": "open", "written_on": "2026-10-01",
      "all_agents": "0"
    },
    "hitCount": 3, "lastHitAt": null, "createdAt": 9, "changedAt": 9
  })
}

fn knowledge(fragments: Vec<Value>) -> Value {
  json!({ "fragments": fragments, "memories": [] })
}

#[tokio::test]
async fn the_memory_reads_ask_the_brain_by_scope_and_map_its_rows() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "brain-token"));

  stub.answer(Method::GET, "/memories", 200, json!({ "items": [memory()], "more": false }));
  stub.answer(
    Method::POST,
    "/memory-matches",
    201,
    json!({ "id": 1, "memoryIds": [4], "actorName": "chat-agent", "spentMs": 0, "tokenCount": 0, "createdAt": 1 }),
  );

  let standing = brain.standing("chat-agent", 7).await.unwrap();
  let conditions = brain.conditions("chat-agent", 7).await.unwrap();
  brain.matched("chat-agent", 7, &["c".to_owned()], &[]).await.unwrap();
  let events = [Event {
    kind: "job-ended".into(),
    item: Some(12),
  }];
  let woken = brain.woken("chat-agent", 7, &events).await.unwrap();

  assert_eq!(standing[0].slug, "c");
  assert_eq!(standing[0].kind, "state");
  assert_eq!(
    standing[0].event,
    Some(Event {
      kind: "job-ended".into(),
      item: Some(12)
    })
  );
  assert_eq!(conditions[0].condition, "when x");
  assert_eq!(woken[0].slug, "c");

  let asked: Vec<_> = stub.seen().into_iter().filter(|seen| seen.path == "/memories").collect();
  assert!(!asked.is_empty());
  assert!(
    asked
      .iter()
      .all(|seen| seen.query.as_deref().is_some_and(|query| query.contains("state=standing")))
  );
  assert_eq!(asked[0].bearer().as_deref(), Some("brain-token"));

  assert_eq!(
    stub.one("/memory-matches").json(),
    json!({ "memoryIds": [4], "actorName": "chat-agent", "spentMs": 0, "tokenCount": 0 })
  );
}

#[tokio::test]
async fn the_fragment_routes_ask_the_knowledge_route_by_scope_and_kind_and_hand_back_what_attached() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/knowledge", 200, knowledge(vec![fragment()]));
  stub.answer(Method::POST, "/fragment-hits", 201, json!({ "recordedCount": 1 }));

  let offered = brain.offered("chat-agent", 7, &["room-rule".to_owned()]).await.unwrap();
  let attached = [Hit {
    key: "bmo:rooms:7:rules:quiet".into(),
    kind: "room-rule".into(),
    chat_id: Some(7),
    owner: None,
    slug: "quiet".into(),
  }];
  brain.hits("chat-agent", 7, &attached).await.unwrap();

  assert_eq!(offered[0].slug, "quiet");
  assert_eq!(offered[0].items, vec![12]);
  assert_eq!(offered[0].hits, 3);
  assert_eq!(offered[0].key, "bmo:rooms:7:rules:quiet");

  let asked = stub.one("/knowledge");
  let query = asked.query.as_deref().unwrap_or_default();
  assert!(query.contains("kinds=room-rule"), "{query}");
  assert!(query.contains("room%3A7") || query.contains("room:7"), "{query}");

  assert_eq!(
    stub.one("/fragment-hits").json(),
    json!({ "keys": ["bmo:rooms:7:rules:quiet"], "actorName": "chat-agent", "scope": "chat-agent:room:7" })
  );
}

#[tokio::test]
async fn the_document_read_filters_the_knowledge_by_its_old_slug() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  let mut row = fragment();
  row["kind"] = json!("library-knowledge");
  row["labels"]["kind"] = json!("library-knowledge");
  row["labels"]["slug"] = json!("k");
  row["path"] = json!("knowledge/k.md");
  row["text"] = json!("a fact");
  row["version"] = json!("v1");
  stub.answer(Method::GET, "/knowledge", 200, knowledge(vec![row]));

  let read = brain.knowledge("chat-agent", 7, &["k".to_owned()]).await.unwrap();

  match read {
    Reply::Answered(documents) => {
      assert_eq!(documents[0].slug, "k");
      assert_eq!(documents[0].text, "a fact");
      assert_eq!(documents[0].version, "v1");
    }
    Reply::Refused(refusal) => panic!("refused {refusal:?}"),
  }
  let asked = stub.one("/knowledge");
  assert!(asked.query.as_deref().is_some_and(|query| query.contains("kinds=library-knowledge")));
}

#[tokio::test]
async fn the_person_book_reads_sheets_and_pieces_from_the_person_fragments() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  let sheet = json!({
    "key": "kakia-chat:people:5:sheet", "kind": "person", "scope": "bmo", "title": null,
    "path": "people/5/sheet.md", "text": "a sheet", "version": "v2", "labels": { "part": "common" },
    "createdAt": 1, "changedAt": 1
  });
  let piece = json!({
    "key": "bmo:rooms:7:people:chunks:p5-humor", "kind": "person", "scope": "bmo:room:7", "title": null,
    "path": "people/5/p.md", "text": "a piece", "version": "v3",
    "labels": { "kind": "person-book", "slug": "p", "owner": "5" }, "createdAt": 1, "changedAt": 1
  });
  stub.answer(Method::GET, "/knowledge", 200, knowledge(vec![sheet, piece]));

  let people = brain.people("chat-agent", 7, &[5], &["p".to_owned()]).await.unwrap();

  match people {
    Reply::Answered(people) => {
      assert!(people.sheets.iter().any(|sheet| sheet.part == "common"));
      assert!(people.pieces.iter().any(|piece| piece.slug == "p" && piece.owner == Some(5)));
    }
    Reply::Refused(refusal) => panic!("refused {refusal:?}"),
  }

  let asked: Vec<_> = stub.seen().into_iter().filter(|seen| seen.path == "/knowledge").collect();
  assert_eq!(asked.len(), 2, "{asked:?}");
  assert!(asked[0].query.as_deref().is_some_and(|query| query.contains("subjectKey=5")));
}

#[tokio::test]
async fn the_room_rules_and_the_loads_go_by_their_own_keys() {
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
  let rules = brain.room_rules(7).await.unwrap();
  let loads = brain.loads("session-1").await.unwrap();

  assert_eq!(rules[0].subject, 9);
  assert_eq!(loads[0].version, "v1");
  assert_eq!(stub.one("/room-rules/read").json(), json!({ "chatId": 7 }));
  assert_eq!(stub.one("/sessions/loads").json(), json!({ "session": "session-1" }));
}
