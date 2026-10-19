//! The agency's session-summariser hook, asked with `{point, ask}` as the agency asks it and answered `{answer}`;
//! an ask that does not read answered with nothing.

use reqwest::StatusCode;
use serde_json::{Value, json};

use crate::ground;

#[tokio::test]
async fn a_workers_own_note_is_carried_to_the_next_run() {
  let ground = ground("own-note", |_| None).await;
  let (status, body) = ground
    .post(
      "/hooks/session-summariser",
      json!({
        "point": "session-summariser",
        "ask": { "kind": "worker", "mode": "claude", "sessionId": "a-session", "cwd": "/a/work/folder", "ownNote": "Halfway through the tests." },
      }),
    )
    .await;

  assert_eq!(status, StatusCode::OK);
  assert!(body["answer"].as_str().unwrap().contains("Halfway through the tests."), "{body}");
}

#[tokio::test]
async fn a_session_with_no_record_leaves_the_word_that_nothing_was_recovered() {
  let ground = ground("lost", |_| None).await;
  let (status, body) = ground
    .post(
      "/hooks/session-summariser",
      json!({ "point": "session-summariser", "ask": { "kind": "chat", "mode": "codex", "cwd": "/a/room/folder", "chatId": 7 } }),
    )
    .await;

  assert_eq!(status, StatusCode::OK);
  assert!(body["answer"].as_str().is_some_and(|answer| !answer.is_empty()), "{body}");
}

#[tokio::test]
async fn an_ask_that_does_not_read_is_answered_with_nothing() {
  let ground = ground("unread", |_| None).await;
  let (status, body) = ground
    .post(
      "/hooks/session-summariser",
      json!({ "point": "session-summariser", "ask": { "kind": "nobody" } }),
    )
    .await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body, json!({ "answer": Value::Null }));
}
