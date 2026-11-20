//! The brain port: the agent's brain found by its key, every read a page of that brain's memories by type and
//! status, each memory read as the brain's own member and mapped to the reference road's rows, and every
//! hit posted by memory id.

use axum::http::Method;
use gate_ports::audience::Audience;
use gate_ports::brain::{Brain, BrainKey, Event, HttpBrain, Reply};
use serde_json::{Value, json};

use super::peer;
use crate::support::stub::Stub;

// The brain the reads are of: the chat agent's, of no account.
fn chat_agent() -> BrainKey {
  BrainKey::unowned("chat-agent")
}

fn brains() -> Value {
  json!({ "items": [{ "id": 9, "accountKey": "1", "agentKey": "chat-agent", "name": "chat-agent", "createdAt": 1 }], "more": false })
}

fn page(items: Vec<Value>) -> Value {
  json!({ "items": items, "more": false })
}

fn room(key: &str) -> Value {
  json!({ "id": 1, "type": "room", "key": key })
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

/// A promise the agent wrote itself, about the room: its words are its text.
fn written_promise() -> Value {
  json!({
    "id": 7, "brainId": 9, "key": null, "type": "promise", "text": "Call back tomorrow.", "layerId": null,
    "position": 0, "subjects": [room("7")], "status": "active", "lineageId": 7, "supersededBy": null,
    "validFrom": 300, "validTo": null, "importance": 5, "hits": 0, "lastHitAt": null, "lastConfirmedAt": null,
    "strength": 1.0, "retrievalStrength": 0.0, "consolidatedAt": null, "actorName": "agent-session",
    "labels": {}, "createdAt": 300
  })
}

/// A moved errand waiting on an event, its event met or not.
fn errand(id: i64, met: bool) -> Value {
  let mut labels = json!({ "chat_id": "7", "event": "job-ended:12" });

  if met {
    labels["event_met_at"] = json!("400");
  }

  json!({
    "id": id, "brainId": 9, "key": null, "type": "promise", "text": "Tell them it ended.", "layerId": null,
    "position": 0, "subjects": [room("7")], "status": "active", "lineageId": id, "supersededBy": null,
    "validFrom": 100, "validTo": null, "importance": 5, "hits": 0, "lastHitAt": null, "lastConfirmedAt": null,
    "strength": 1.0, "retrievalStrength": 0.0, "consolidatedAt": null, "actorName": "move", "labels": labels,
    "createdAt": 100
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

/// A subject of the brain's, as its subjects route lists it.
fn subject(id: i64, kind: &str, key: &str, name: Option<&str>) -> Value {
  json!({ "id": id, "brainId": 9, "type": kind, "key": key, "description": "", "name": name, "createdAt": 9 })
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

  let standing = brain.standing(&chat_agent(), 7).await.unwrap();
  let conditions = brain.conditions(&chat_agent(), 7).await.unwrap();
  let events = [Event {
    kind: "job-ended".into(),
    item: Some(12),
  }];
  let woken = brain.woken(&chat_agent(), 7, &events).await.unwrap();

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
  assert!(brains_asked.query.as_deref().is_some_and(|q| q.contains("kind=agent")));
  assert_eq!(brains_asked.bearer().as_deref(), Some("brain-token"));
  let asked: Vec<_> = stub.seen().into_iter().filter(|seen| seen.path == "/brains/9/memories").collect();
  assert!(
    asked
      .iter()
      .all(|seen| seen.query.as_deref().is_some_and(|q| q.contains("status=active")))
  );
}

#[tokio::test]
async fn a_row_the_agent_wrote_stands_by_its_text_and_an_errand_stands_once_its_event_has_come() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/brains", 200, brains());
  served(&stub, "promise", vec![written_promise(), errand(8, false), errand(9, true)]);

  let standing = brain.standing(&chat_agent(), 7).await.unwrap();
  let ids: Vec<i64> = standing.iter().map(|row| row.id).collect();

  // Every standing type is asked for and the stub answers the same page for each, so each row stands once a type.
  assert!(ids.iter().all(|id| *id == 7 || *id == 9), "{ids:?}");
  assert!(ids.contains(&7) && ids.contains(&9));

  let written = standing.iter().find(|row| row.id == 7).unwrap();
  let come = standing.iter().find(|row| row.id == 9).unwrap();

  assert_eq!(written.action, "Call back tomorrow.");
  assert_eq!((written.condition.as_str(), written.event_met_at), ("", None));
  assert_eq!(come.event_met_at, Some(400));
}

#[tokio::test]
async fn the_fragment_reads_ask_the_brain_by_type() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/brains", 200, brains());
  served(&stub, "rule", vec![rule()]);

  let offered = brain.offered(&chat_agent(), 7, &["room-rule".to_owned()]).await.unwrap();

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
}

#[tokio::test]
async fn the_document_read_filters_the_knowledge_by_its_slug() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/brains", 200, brains());
  served(&stub, "knowledge", vec![knowledge_piece()]);

  let read = brain.knowledge(&chat_agent(), 7, &["tomatoes".to_owned()]).await.unwrap();
  let Reply::Answered(documents) = read else { panic!("answered") };
  assert_eq!(documents.len(), 1);
  assert_eq!(documents[0].path, "knowledge/tomatoes.md");
  assert_eq!(documents[0].text, "Tomatoes like sun.");
  assert_eq!(documents[0].version, "40");

  let none = brain.knowledge(&chat_agent(), 7, &["none".to_owned()]).await.unwrap();
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

  let offered = brain.offered(&chat_agent(), 7, &["lore".to_owned()]).await.unwrap();
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
    .lore(&chat_agent(), &["founding".to_owned(), "elsewhere".to_owned()])
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
async fn a_persons_sheet_is_the_brains_rendering_of_their_facts_in_the_room() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/brains", 200, brains());
  stub.answer(
    Method::GET,
    "/brains/9/subjects",
    200,
    page(vec![
      subject(3, "room", "7", None),
      subject(4, "person", "31", Some("Robin")),
      subject(5, "person", "32", None),
    ]),
  );
  stub.canned(
    Method::GET,
    "/brains/9/subjects/4/sheet",
    200,
    "text/plain",
    "- [#21 since 2026-01-02] Likes tea.\n- [#22 since 2026-02-03] Keeps a garden.".into(),
  );
  stub.canned(Method::GET, "/brains/9/subjects/5/sheet", 200, "text/plain", String::new());

  let sheets = brain.sheets(&chat_agent(), 7, &[31, 32, 33], None).await.unwrap();

  assert_eq!(sheets.len(), 1);
  assert_eq!((sheets[0].person, sheets[0].path.as_str()), (31, "rooms/7/people/31/sheet.md"));
  assert_eq!(
    sheets[0].text,
    "- [#21 since 2026-01-02] Likes tea.\n- [#22 since 2026-02-03] Keeps a garden."
  );
  assert_eq!(stub.one("/brains/9/subjects/4/sheet").query.as_deref(), Some("roomId=3"));

  // A head is asked for by its line count.
  brain.sheets(&chat_agent(), 7, &[31], Some(8)).await.unwrap();

  let heads: Vec<Option<String>> = stub
    .seen()
    .into_iter()
    .filter(|seen| seen.path == "/brains/9/subjects/4/sheet")
    .map(|seen| seen.query)
    .collect();

  assert_eq!(heads.last().unwrap().as_deref(), Some("roomId=3&limit=8"));
  assert!(
    stub
      .seen()
      .iter()
      .all(|seen| !seen.query.as_deref().unwrap_or_default().contains("type=sheet"))
  );
}

#[tokio::test]
async fn the_person_book_offers_one_candidate_for_each_person_the_facts_are_about() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));

  stub.answer(Method::GET, "/brains", 200, brains());
  stub.answer(
    Method::GET,
    "/brains/9/tallies",
    200,
    json!([
      { "group": "4", "count": 12, "importance": 5.0, "strength": 1.0, "retrievalStrength": 0.0, "latestValidFrom": 9 },
      { "group": "3", "count": 7, "importance": 5.0, "strength": 1.0, "retrievalStrength": 0.0, "latestValidFrom": 9 },
      { "group": "5", "count": 2, "importance": 5.0, "strength": 1.0, "retrievalStrength": 0.0, "latestValidFrom": 9 },
    ]),
  );
  stub.answer(
    Method::GET,
    "/brains/9/subjects",
    200,
    page(vec![
      subject(3, "room", "7", None),
      subject(4, "person", "31", Some("Robin")),
      subject(5, "person", "32", None),
    ]),
  );

  let offered = brain.offered(&chat_agent(), 7, &["person-book".to_owned()]).await.unwrap();
  let read: Vec<(&str, &str, Option<i64>, &str, &str)> = offered
    .iter()
    .map(|row| (row.kind.as_str(), row.slug.as_str(), row.owner, row.title.as_str(), row.path.as_str()))
    .collect();

  assert_eq!(
    read,
    [
      ("person-book", "person-31", Some(31), "Robin", "rooms/7/people/31/sheet.md"),
      ("person-book", "person-32", Some(32), "32", "rooms/7/people/32/sheet.md"),
    ]
  );

  let tallies = stub.one("/brains/9/tallies").query.unwrap_or_default();

  assert!(tallies.contains("type=fact") && tallies.contains("by=subject"), "{tallies}");
  assert!(stub.seen().iter().all(|seen| seen.path != "/brains/9/memories"));
}

#[tokio::test]
async fn each_supervisor_is_read_from_its_own_accounts_brain_and_a_name_on_two_accounts_from_none() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));
  let listed = |id: i64, account: &str, agent: &str| json!({ "id": id, "accountKey": account, "agentKey": agent, "name": agent, "createdAt": 1 });

  stub.answer(
    Method::GET,
    "/brains",
    200,
    page(vec![
      listed(22, "7", "u7"),
      listed(23, "8", "u8"),
      listed(30, "7", "helper"),
      listed(31, "8", "helper"),
    ]),
  );
  stub.answer(Method::GET, "/brains/22/memories", 200, page(vec![rule()]));
  stub.answer(Method::GET, "/brains/23/memories", 200, page(vec![rule()]));

  let rules = ["room-rule".to_owned()];
  let first = brain.offered(&BrainKey::owned("u7", 7), 7, &rules).await.unwrap();

  assert_eq!(first.len(), 1);

  let asked: Vec<String> = stub.seen().into_iter().map(|seen| seen.path).collect();

  assert!(
    asked.contains(&"/brains/22/memories".to_owned()) && !asked.contains(&"/brains/23/memories".to_owned())
  );
  assert!(stub.one("/brains").query.unwrap_or_default().contains("accountKey=7"));

  let second = brain.offered(&BrainKey::owned("u8", 8), 7, &rules).await.unwrap();

  assert_eq!(second.len(), 1);
  assert!(stub.seen().iter().any(|seen| seen.path == "/brains/23/memories"));

  for (key, why) in [
    (BrainKey::owned("u7", 8), "a supervisor's name under another account"),
    (BrainKey::unowned("helper"), "a name of no account on two accounts' brains"),
    (BrainKey::unowned("nobody"), "a name the brain keeps no brain of"),
  ] {
    let before = stub.seen().len();

    assert!(!brain.kept(&key).await.unwrap(), "{why}");
    assert!(brain.offered(&key, 7, &rules).await.unwrap().is_empty(), "{why}");
    assert!(brain.standing(&key, 7).await.unwrap().is_empty(), "{why}");
    assert!(brain.sheets(&key, 7, &[31], None).await.unwrap().is_empty(), "{why}");
    assert!(
      stub.seen()[before..].iter().all(|seen| seen.path == "/brains"),
      "{why}: no brain's members are read"
    );
  }
}

#[tokio::test]
async fn an_org_brain_is_found_by_its_company_and_unit_and_read_by_topic_and_whole() {
  let stub = Stub::start().await;
  let brain = HttpBrain::new(peer(&stub, "t"));
  let topic = json!({ "id": 2, "type": "topic", "key": "working-hours" });

  stub.answer(
    Method::GET,
    "/brains",
    200,
    page(vec![
      json!({ "id": 40, "kind": "org", "accountKey": "1", "agentKey": "3", "name": "3", "createdAt": 1 }),
    ]),
  );
  stub.answer(
    Method::GET,
    "/org-topics",
    200,
    json!([{ "topic": "working-hours", "brainId": 40, "locked": true, "memories": [{
      "id": 5, "type": "fact", "text": "07:00 to 16:00", "subjects": [topic], "importance": 6, "locked": true,
      "validFrom": 100, "createdAt": 90, "status": "active"
    }] }]),
  );
  stub.answer(
    Method::GET,
    "/brains/40/memories",
    200,
    page(vec![json!({
      "id": 6, "type": "fact", "text": "Reports go out on Friday.", "subjects": [], "importance": 4,
      "recallCondition": "a weekly report comes up", "validFrom": 200, "createdAt": 200, "status": "active",
      "internalOnly": false
    })]),
  );

  assert_eq!(brain.org_brain(1, 3).await.unwrap(), Some(40));
  assert_eq!(brain.org_brain(1, 3).await.unwrap(), Some(40));
  assert_eq!(brain.org_brain(1, 9).await.unwrap(), None);

  let found: Vec<String> = stub
    .seen()
    .into_iter()
    .filter(|seen| seen.path == "/brains")
    .filter_map(|seen| seen.query)
    .collect();

  assert_eq!(found.len(), 2, "a brain found is remembered: {found:?}");
  assert!(
    found[0].contains("kind=org") && found[0].contains("accountKey=1") && found[0].contains("agentKey=3")
  );

  let standing = brain.org_topics(&[10, 40], Audience::External).await.unwrap();

  assert_eq!(stub.one("/org-topics").query.as_deref(), Some("brainIds=10%2C40&audience=external"));
  assert_eq!(standing.len(), 1);
  assert_eq!((standing[0].brain, standing[0].locked), (40, true));
  assert_eq!(standing[0].memories[0].topics, ["working-hours"]);
  assert!(standing[0].memories[0].locked);
  assert!(
    standing[0].memories[0].internal_only,
    "a memory not marked either way is read as internal-only"
  );

  let memories = brain.org_memories(40).await.unwrap();
  let asked = stub.one("/brains/40/memories").query.unwrap_or_default();

  assert!(
    asked.contains("excludeTypes=rumor%2Cepisode") && asked.contains("status=active"),
    "{asked}"
  );
  assert!(!asked.contains("type="), "no type is named, so the read records no use: {asked}");
  assert_eq!(memories[0].recall_condition.as_deref(), Some("a weekly report comes up"));
  assert!(memories[0].topics.is_empty());
  assert!(!memories[0].internal_only);
}
