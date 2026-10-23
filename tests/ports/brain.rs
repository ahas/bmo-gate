//! The brain port: the agent's brain found by its key, every read a page of that brain's memories by type and
//! status, each memory read as the brain's own member and mapped to the reference road's rows, and every
//! hit posted by memory id.

use axum::http::Method;
use gate_ports::brain::{Brain, Event, Hit, HttpBrain, Reply};
use serde_json::{Value, json};

use crate::peer;
use crate::stub::Stub;

fn brains() -> Value {
  json!({ "items": [{ "id": 9, "accountKey": "1", "agentKey": "chat-agent", "name": "chat-agent", "createdAt": 1 }], "more": false })
}

fn page(items: Vec<Value>) -> Value {
  json!({ "items": items, "more": false })
}

fn room(key: &str) -> Value {
  json!({ "id": 1, "type": "room", "key": key })
}

fn person(key: &str) -> Value {
  json!({ "id": 2, "type": "person", "key": key })
}

/// A moved state row, its old fields kept in its labels.
fn moved_state() -> Value {
  json!({
    "id": 4, "brainId": 9, "key": null, "type": "state", "text": "a row", "layerId": null, "position": 0,
    "subjects": [room("7")], "status": "active", "lineageId": 4, "supersededBy": null, "validFrom": 100,
    "validTo": null, "importance": 5, "hits": 0, "lastHitAt": null, "lastConfirmedAt": null, "strength": 1.0,
    "retrievalStrength": 0.0, "consolidatedAt": null, "actorName": "move",
    "labels": {
      "slug": "c", "agent": "chat-agent", "chat_id": "7", "reach": "room", "event": "job-ended:12",
      "conditions": "[{\"type\":\"state\",\"event\":\"job-ended:12\",\"reach\":\"room\",\"condition\":\"when x\"}]"
    },
    "createdAt": 100
  })
}

/// A situation the agent wrote itself: no old labels, its condition its own text, about the room.
fn written_situation() -> Value {
  json!({
    "id": 5, "brainId": 9, "key": null, "type": "situation", "text": "When asked the time, answer in one line.",
    "layerId": null, "position": 0, "subjects": [room("7")], "status": "active", "lineageId": 5,
    "supersededBy": null, "validFrom": 200, "validTo": null, "importance": 6, "hits": 2, "lastHitAt": 150,
    "lastConfirmedAt": null, "strength": 1.0, "retrievalStrength": 0.3, "consolidatedAt": null,
    "actorName": "agent-session", "labels": {}, "createdAt": 200
  })
}

/// A promise about another room, which this room never reads.
fn elsewhere() -> Value {
  json!({
    "id": 6, "brainId": 9, "key": null, "type": "promise", "text": "elsewhere", "layerId": null, "position": 0,
    "subjects": [room("8")], "status": "active", "lineageId": 6, "supersededBy": null, "validFrom": 100,
    "validTo": null, "importance": 5, "hits": 0, "lastHitAt": null, "lastConfirmedAt": null, "strength": 1.0,
    "retrievalStrength": 0.0, "consolidatedAt": null, "actorName": "move", "labels": {}, "createdAt": 100
  })
}

fn rule() -> Value {
  json!({
    "id": 3, "brainId": 9, "key": "bmo:rooms:7:rules:quiet", "type": "rule", "text": "quiet", "layerId": null,
    "position": 1, "subjects": [room("7")], "status": "active", "lineageId": 3, "supersededBy": null,
    "validFrom": 9, "validTo": null, "importance": 5, "hits": 3, "lastHitAt": null, "lastConfirmedAt": null,
    "strength": 1.0, "retrievalStrength": 0.0, "consolidatedAt": null, "actorName": "move",
    "labels": {
      "kind": "room-rule", "slug": "quiet", "agent": "chat-agent", "chat_id": "7", "position": "1",
      "keywords": "[\"quiet\"]", "items": "[12]", "status": "open", "written_on": "2026-10-01",
      "all_agents": "0", "title": "Quiet hours", "path": "rooms/7/rules/quiet.md"
    },
    "createdAt": 9
  })
}

fn sheet(id: i64, key: &str, labels: Value) -> Value {
  json!({
    "id": id, "brainId": 9, "key": key, "type": "sheet", "text": format!("sheet {id}"), "layerId": null,
    "position": 0, "subjects": [person("31"), room("7")], "status": "active", "lineageId": id,
    "supersededBy": null, "validFrom": 9, "validTo": null, "importance": 5, "hits": 0, "lastHitAt": null,
    "lastConfirmedAt": null, "strength": 1.0, "retrievalStrength": 0.0, "consolidatedAt": null,
    "actorName": "move", "labels": labels, "createdAt": 9
  })
}

fn knowledge_piece() -> Value {
  json!({
    "id": 40, "brainId": 9, "key": "bmo:knowledge:tomatoes", "type": "knowledge", "text": "Tomatoes like sun.",
    "layerId": 1, "position": 0, "subjects": [], "status": "active", "lineageId": 40, "supersededBy": null,
    "validFrom": 9, "validTo": null, "importance": 5, "hits": 0, "lastHitAt": null, "lastConfirmedAt": null,
    "strength": 1.0, "retrievalStrength": 0.0, "consolidatedAt": null, "actorName": "move",
    "labels": { "slug": "tomatoes", "path": "knowledge/tomatoes.md" }, "createdAt": 9
  })
}

/// A lore piece in a layer, at a position, its labels as the persona's installer writes them.
fn lore_piece(id: i64, slug: &str, layer: i64, position: i64, labels: Value) -> Value {
  json!({
    "id": id, "brainId": 9, "key": format!("lore/{slug}"), "type": "lore", "text": format!("the piece {slug}"),
    "layerId": layer, "position": position, "subjects": [], "status": "active", "lineageId": id,
    "supersededBy": null, "validFrom": 9, "validTo": null, "importance": 5, "hits": 0, "lastHitAt": null,
    "lastConfirmedAt": null, "strength": 1.0, "retrievalStrength": 0.0, "consolidatedAt": null,
    "actorName": "installer", "labels": labels, "createdAt": 9
  })
}

fn layer(id: i64, name: &str, position: i64) -> Value {
  json!({ "id": id, "brainId": 9, "name": name, "description": name, "position": position, "createdAt": 9 })
}

fn served(stub: &Stub, kind: &str, items: Vec<Value>) {
  stub.answer(Method::GET, "/brains/9/memories", 200, page(items));
  let _ = kind;
}

#[tokio::test]
async fn the_memory_reads_find_the_agents_brain_and_map_its_standing_types() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "brain-token"));

  stub.answer(Method::GET, "/brains", 200, brains());
  // Every standing type is asked for; the stub answers the same page for each.
  served(&stub, "promise", vec![moved_state(), written_situation(), elsewhere()]);
  stub.answer(Method::POST, "/brains/9/hits", 201, json!({ "recordedCount": 1 }));

  let standing = brain.standing("chat-agent", 7).await.unwrap();
  let conditions = brain.conditions("chat-agent", 7).await.unwrap();
  brain.matched("chat-agent", 7, &["c".to_owned()], &[]).await.unwrap();
  let events = [Event {
    kind: "job-ended".into(),
    item: Some(12),
  }];
  let woken = brain.woken("chat-agent", 7, &events).await.unwrap();

  // The moved row waits on an event, so it is woken rather than standing; the room 8 promise is not read here.
  assert!(standing.iter().all(|row| row.chat_id == Some(7)), "{standing:?}");
  assert!(!standing.iter().any(|row| row.slug == "c" || row.slug == "memory-6"), "{standing:?}");
  assert_eq!(woken.len(), 1);
  assert_eq!(woken[0].slug, "c");
  assert_eq!(
    woken[0].event,
    Some(Event {
      kind: "job-ended".into(),
      item: Some(12)
    })
  );
  let slugs: Vec<&str> = conditions.iter().map(|c| c.slug.as_str()).collect();
  assert!(slugs.contains(&"c") && slugs.contains(&"memory-5"), "{slugs:?}");
  assert_eq!(conditions.iter().find(|c| c.slug == "c").unwrap().condition, "when x");
  assert_eq!(
    conditions.iter().find(|c| c.slug == "memory-5").unwrap().condition,
    "When asked the time, answer in one line."
  );

  let brains_asked = stub.one("/brains");
  assert!(brains_asked.query.as_deref().is_some_and(|q| q.contains("agentKey=chat-agent")));
  assert_eq!(brains_asked.bearer().as_deref(), Some("brain-token"));
  let asked: Vec<_> = stub.seen().into_iter().filter(|seen| seen.path == "/brains/9/memories").collect();
  assert!(
    asked
      .iter()
      .all(|seen| seen.query.as_deref().is_some_and(|q| q.contains("status=active")))
  );
  assert_eq!(
    stub.one("/brains/9/hits").json(),
    json!({ "memoryIds": [4], "actorName": "chat-agent" })
  );
}

#[tokio::test]
async fn the_fragment_reads_ask_the_brain_by_type_and_hand_back_what_attached_by_id() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/brains", 200, brains());
  served(&stub, "rule", vec![rule()]);
  stub.answer(Method::POST, "/brains/9/hits", 201, json!({ "recordedCount": 1 }));

  let offered = brain.offered("chat-agent", 7, &["room-rule".to_owned()]).await.unwrap();
  let attached = [Hit {
    key: "3".into(),
    kind: "room-rule".into(),
    chat_id: Some(7),
    owner: None,
    slug: "quiet".into(),
  }];
  brain.hits("chat-agent", 7, &attached).await.unwrap();

  assert_eq!(offered[0].slug, "quiet");
  assert_eq!(offered[0].items, vec![12]);
  assert_eq!(offered[0].hits, 3);
  assert_eq!(offered[0].key, "3");
  assert_eq!(offered[0].kind, "room-rule");
  assert_eq!(offered[0].path, "rooms/7/rules/quiet.md");
  assert_eq!(offered[0].chat_id, Some(7));

  let asked = stub.one("/brains/9/memories");
  let query = asked.query.as_deref().unwrap_or_default();
  assert!(query.contains("type=rule"), "{query}");
  assert_eq!(
    stub.one("/brains/9/hits").json(),
    json!({ "memoryIds": [3], "actorName": "chat-agent" })
  );
}

#[tokio::test]
async fn the_document_read_filters_the_knowledge_by_its_slug() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/brains", 200, brains());
  served(&stub, "knowledge", vec![knowledge_piece()]);

  let read = brain.knowledge("chat-agent", 7, &["tomatoes".to_owned()]).await.unwrap();
  let Reply::Answered(documents) = read else { panic!("answered") };
  assert_eq!(documents.len(), 1);
  assert_eq!(documents[0].path, "knowledge/tomatoes.md");
  assert_eq!(documents[0].text, "Tomatoes like sun.");
  assert_eq!(documents[0].version, "40");

  let none = brain.knowledge("chat-agent", 7, &["none".to_owned()]).await.unwrap();
  let Reply::Answered(documents) = none else { panic!("answered") };
  assert!(documents.is_empty());
}

#[tokio::test]
async fn the_lore_stands_in_its_layers_order_and_a_piece_is_read_by_its_slug() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/brains", 200, brains());
  stub.answer(
    Method::GET,
    "/brains/9/layers",
    200,
    page(vec![layer(11, "persona", 0), layer(13, "lore/The town", 2), layer(12, "lore", 1)]),
  );
  served(
    &stub,
    "lore",
    vec![
      lore_piece(
        50,
        "harbour",
        13,
        0,
        json!({ "source": "lore/chunks/harbour.md", "title": "the harbour" }),
      ),
      lore_piece(
        51,
        "founding",
        12,
        1,
        json!({ "source": "lore/chunks/founding.md", "title": "how the town began", "scope": "[old]" }),
      ),
      lore_piece(
        52,
        "weather",
        12,
        0,
        json!({ "source": "lore/chunks/weather.md", "title": "the weather" }),
      ),
    ],
  );

  let offered = brain.offered("chat-agent", 7, &["lore".to_owned()]).await.unwrap();
  let placed: Vec<(&str, Option<&str>, &str)> = offered
    .iter()
    .map(|row| (row.slug.as_str(), row.section.as_deref(), row.title.as_str()))
    .collect();

  assert_eq!(
    placed,
    [
      ("weather", Some("lore"), "the weather"),
      ("founding", Some("lore"), "how the town began"),
      ("harbour", Some("lore/The town"), "the harbour"),
    ]
  );
  assert_eq!(offered[1].scope.as_deref(), Some("[old]"));
  assert_eq!(offered[0].scope, None);
  assert_eq!((offered[0].key.as_str(), offered[0].kind.as_str()), ("52", "lore"));
  assert_eq!(offered[0].path, "memories/52");

  let query = stub.one("/brains/9/memories").query.unwrap_or_default();
  assert!(query.contains("type=lore") && query.contains("status=active"), "{query}");

  let read = brain
    .lore("chat-agent", &["founding".to_owned(), "elsewhere".to_owned()])
    .await
    .unwrap();
  assert_eq!(read.len(), 1);
  assert_eq!(
    (
      read[0].slug.as_str(),
      read[0].path.as_str(),
      read[0].text.as_str(),
      read[0].version.as_str()
    ),
    ("founding", "memories/51", "the piece founding", "51")
  );
}

#[tokio::test]
async fn the_person_book_reads_the_speakers_sheets_and_the_pieces_asked_for() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/brains", 200, brains());
  served(
    &stub,
    "sheet",
    vec![
      sheet(
        21,
        "bmo:people:31:common",
        json!({ "part": "common", "owner": "31", "path": "people/31/common.md" }),
      ),
      sheet(
        22,
        "bmo:people:31:chunks:garden",
        json!({ "kind": "person-book", "slug": "garden", "owner": "31" }),
      ),
      sheet(23, "bmo:people:32:common", json!({ "part": "common", "owner": "32" })),
    ],
  );

  let read = brain.people("chat-agent", 7, &[31], &["garden".to_owned()]).await.unwrap();
  let Reply::Answered(people) = read else { panic!("answered") };
  assert_eq!(people.sheets.len(), 1);
  assert_eq!((people.sheets[0].person, people.sheets[0].part.as_str()), (31, "common"));
  assert_eq!(people.sheets[0].path, "people/31/common.md");
  assert_eq!(people.pieces.len(), 1);
  assert_eq!((people.pieces[0].slug.as_str(), people.pieces[0].owner), ("garden", Some(31)));
}

#[tokio::test]
async fn the_room_rules_and_the_loads_go_by_their_own_keys() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(
    Method::POST,
    "/room-rules/read",
    200,
    json!({ "rules": [{ "id": "quiet", "subject": 31, "text": "quiet" }] }),
  );
  stub.answer(
    Method::POST,
    "/sessions/loads",
    200,
    json!({ "loads": [{ "path": "rooms/7/rules/quiet.md", "version": "h" }] }),
  );

  let rules = brain.room_rules(7).await.unwrap();
  let loads = brain.loads("s").await.unwrap();

  assert_eq!((rules[0].id.as_str(), rules[0].subject), ("quiet", 31));
  assert_eq!(loads[0].version, "h");
  assert_eq!(stub.one("/room-rules/read").json(), json!({ "chatId": 7 }));
  assert_eq!(stub.one("/sessions/loads").json(), json!({ "session": "s" }));
}
