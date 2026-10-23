//! The receiver port: each room fact's route and query, its answer read, the owner notice's code carried beside
//! its fields, a stored message read by its room and number, none where the receiver keeps none, and the draft rows
//! read off the event stream and nothing else of it, a question's start among what is let go.

use axum::http::Method;
use futures_util::StreamExt;
use gate_ports::receiver::{Drafted, HttpReceiver, Message, Name, OwnerSpoke, Receiver, Roads};
use serde_json::{Map, json};

use crate::peer;
use crate::stub::Stub;

#[tokio::test]
async fn every_room_fact_is_asked_by_its_path_and_read_back() {
  let stub = Stub::start().await;
  let receiver = HttpReceiver::new(peer(&stub, "receiver-token"));

  stub.answer(
    Method::GET,
    "/rooms",
    200,
    json!({ "items": [{ "id": 7, "title": "A room", "messageCount": 3, "pinned": false, "senders": [5, 6] }], "more": false }),
  );
  stub.answer(Method::GET, "/rooms/7/roads", 200, json!({ "kind": "group", "oneToOne": false }));
  stub.answer(Method::GET, "/rooms/7/spoke-between", 200, json!({ "spoke": true }));
  stub.answer(Method::GET, "/rooms/7/owner-spoke", 200, json!({ "owner": true, "spoke": false }));
  stub.answer(
    Method::GET,
    "/people",
    200,
    json!({ "items": [{ "id": 5, "name": "Someone" }, { "id": 6, "name": null }], "more": false }),
  );
  stub.answer(Method::POST, "/promise-readings", 200, json!({ "waits": true }));

  let titles = receiver.titles().await.unwrap();
  let roads = receiver.roads(7).await.unwrap();
  let spoke = receiver.spoke_between(7, 5, 100, 200).await.unwrap();
  let owner = receiver.owner_spoke(7, 5, 300, 60_000).await.unwrap();
  let names = receiver.names(&[5, 6]).await.unwrap();
  let waits = receiver.waits("once the build is done").await.unwrap();

  assert_eq!((titles[0].chat_id, titles[0].title.as_deref()), (7, Some("A room")));
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

  assert_eq!(stub.one("/rooms/7/spoke-between").query.as_deref(), Some("person=5&from=100&to=200"));
  assert_eq!(
    stub.one("/rooms/7/owner-spoke").query.as_deref(),
    Some("person=5&before=300&windowMs=60000")
  );
  assert_eq!(stub.one("/people").query.as_deref(), Some("ids=5%2C6"));
  assert_eq!(stub.one("/promise-readings").json(), json!({ "text": "once the build is done" }));
  assert_eq!(stub.one("/rooms").bearer().as_deref(), Some("receiver-token"));
}

#[tokio::test]
async fn no_one_s_names_are_asked_for_no_one() {
  let stub = Stub::start().await;
  let receiver = HttpReceiver::new(peer(&stub, "t"));

  assert_eq!(receiver.names(&[]).await.unwrap(), Vec::<Name>::new());
  assert!(stub.seen().is_empty());
}

#[tokio::test]
async fn an_owner_notice_carries_its_code_beside_its_fields() {
  let stub = Stub::start().await;
  let receiver = HttpReceiver::new(peer(&stub, "t"));
  let mut fields = Map::new();

  fields.insert("row".into(), json!(41));
  fields.insert("stage".into(), json!("library-knowledge"));
  stub.answer(Method::POST, "/owner/notices", 201, json!({ "id": 12 }));

  receiver.owner_notice("attachment-alarm", &fields).await.unwrap();

  assert_eq!(
    stub.one("/owner/notices").json(),
    json!({ "code": "attachment-alarm", "row": 41, "stage": "library-knowledge" })
  );
}

#[tokio::test]
async fn a_stored_message_is_read_by_its_room_and_number_and_the_agent_s_own_number_asked() {
  let stub = Stub::start().await;
  let receiver = HttpReceiver::new(peer(&stub, "t"));

  stub.answer(
    Method::GET,
    "/rooms/-7/messages/9",
    200,
    json!({
      "id": 9, "room": -7, "senderId": 5, "senderName": "Someone", "sentAt": 1_700_000_000_000_i64, "text": "hello",
      "imagePath": null, "replyToMessageId": null, "files": []
    }),
  );
  stub.answer(Method::GET, "/rooms/-7/own-number", 200, json!({ "number": 42 }));

  assert_eq!(
    receiver.message(-7, 9).await.unwrap(),
    Some(Message {
      sender: Some(5),
      sender_name: Some("Someone".into()),
      sent_at: 1_700_000_000_000,
      text: "hello".into(),
    })
  );
  assert_eq!(receiver.message(-7, 10).await.unwrap(), None);
  assert_eq!(receiver.own_number("the-chat-agent", -7).await.unwrap(), Some(42));
  assert_eq!(stub.one("/rooms/-7/own-number").query.as_deref(), Some("agentName=the-chat-agent"));
}

#[tokio::test]
async fn the_draft_rows_are_read_off_the_event_stream_and_nothing_else_is() {
  let stub = Stub::start().await;
  let receiver = HttpReceiver::new(peer(&stub, "receiver-token"));
  let row = json!({
    "type": "draft", "chatId": 7, "messageId": null, "round": "round-1", "agentName": "the-chat-agent", "number": 2,
    "question": "facts", "kind": "question", "answerChars": 120, "changed": true, "outcome": "answered",
    "detail": null, "ms": 900, "at": 1_700_000_000, "id": 4
  });
  let message = json!({ "type": "message", "chatId": 7, "messageId": 30, "id": 3, "at": 1_700_000_000 });
  let start = json!({
    "type": "draft", "chatId": 7, "round": "round-1", "agentName": "the-chat-agent", "number": 2, "count": 5,
    "question": "facts", "kind": "start", "at": 1_700_000_000, "id": 2
  });
  let body = format!(
    "event: run\ndata: {{\"run\":\"a-run\"}}\n\nid: 2\nevent: bot\ndata: {start}\n\nid: 3\nevent: bot\ndata: {message}\n\n\
     id: 4\nevent: bot\ndata: {row}\n\n\
     event: live\ndata: {{\"at\":1,\"turns\":[],\"compacting\":[],\"queued\":[]}}\n\n: ping\n\n"
  );

  stub.canned(Method::GET, "/events", 200, "text/event-stream", body);

  let rows: Vec<_> = receiver.drafts().await.unwrap().collect().await;

  assert_eq!(rows.len(), 1, "{rows:?}");
  assert_eq!(
    rows.into_iter().next().unwrap().unwrap(),
    Drafted {
      chat_id: 7,
      round: "round-1".into(),
      agent_name: "the-chat-agent".into(),
      number: 2,
      question: "facts".into(),
      kind: "question".into(),
      answer_chars: 120,
      changed: true,
      outcome: "answered".into(),
      detail: None,
      ms: 900,
    }
  );
  assert_eq!(stub.one("/events").bearer().as_deref(), Some("receiver-token"));
}
