//! The receiver port: the draft rows read off the event stream and nothing else of it, a question's start among
//! what is let go; and a room's audience asked for an agent.

use axum::http::Method;
use futures_util::StreamExt;
use gate_ports::audience::Audience;
use gate_ports::receiver::{Drafted, HttpReceiver, Receiver};
use serde_json::json;

use super::peer;
use crate::support::stub::Stub;

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

#[tokio::test]
async fn a_rooms_audience_is_asked_for_an_agent_and_a_room_not_held_is_refused() {
  let stub = Stub::start().await;
  let receiver = HttpReceiver::new(peer(&stub, "receiver-token"));

  stub.answer(
    Method::GET,
    "/rooms/7/audience",
    200,
    json!({ "room": 7, "agent": "the-chat-agent", "audience": "internal" }),
  );
  stub.answer(
    Method::GET,
    "/rooms/8/audience",
    404,
    json!({ "code": "not-found", "error": "no such room" }),
  );

  assert_eq!(receiver.audience(7, "the-chat-agent").await.unwrap(), Audience::Internal);

  let asked = stub.one("/rooms/7/audience");

  assert_eq!(asked.query.as_deref(), Some("agent=the-chat-agent"));
  assert_eq!(asked.bearer().as_deref(), Some("receiver-token"));
  assert_eq!(
    receiver.audience(8, "the-chat-agent").await.unwrap_err().refused_with(),
    Some("not-found")
  );
}
