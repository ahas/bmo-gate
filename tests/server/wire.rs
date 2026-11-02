//! The wire every route shares: the bearer token, a route that is not there, a body that is not JSON or not as
//! asked, the health, the event stream, the gate order and the stage runs it does not carry.

use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::json;

use super::{ROOM, TOKEN, ground, refused};

#[tokio::test]
async fn a_call_without_the_token_is_refused() {
  let ground = ground("token", |_| None).await;
  let bare = ground.client.get(format!("{}/health", ground.address)).send().await.unwrap();

  assert_eq!(bare.status(), StatusCode::UNAUTHORIZED);
  refused(&bare.json().await.unwrap(), "unauthorized");

  let wrong = ground
    .client
    .get(format!("{}/health", ground.address))
    .bearer_auth("another")
    .send()
    .await
    .unwrap();

  assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_route_that_is_not_there_is_refused() {
  let ground = ground("absent", |_| None).await;

  for (status, body) in [ground.get("/nowhere").await, ground.post("/health", json!({})).await] {
    assert_eq!(status, StatusCode::NOT_FOUND);
    refused(&body, "no-route");
  }
}

#[tokio::test]
async fn a_body_not_json_or_not_as_asked_is_refused() {
  let ground = ground("body", |_| None).await;
  let response = ground
    .client
    .post(format!("{}/translations", ground.address))
    .bearer_auth(TOKEN)
    .header("content-type", "application/json")
    .body("{ not json")
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), StatusCode::BAD_REQUEST);
  refused(&response.json().await.unwrap(), "bad-request");

  let (status, body) = ground.post("/translations", json!({ "originals": ["a room's message"] })).await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&body, "bad-request");
}

#[tokio::test]
async fn the_health_says_the_version_and_the_database() {
  let ground = ground("health", |_| None).await;
  let (status, body) = ground.get("/health").await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body["version"], gate_server::routes::health::bmo_version());
  assert_eq!(body["ready"], true);
  assert_eq!(body["reason"], serde_json::Value::Null);
  assert!(body.get("laya").is_none(), "{body}");
}

#[tokio::test]
async fn the_event_stream_tells_of_a_judgement_written() {
  let ground = ground("events", |_| None).await;
  let response = ground
    .client
    .get(format!("{}/events", ground.address))
    .bearer_auth(TOKEN)
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), StatusCode::OK);

  let mut stream = response.bytes_stream();
  let (status, _) = ground
    .post("/judgements", json!({ "roomId": ROOM, "gateName": "chat", "verdict": "SKIP" }))
    .await;

  assert_eq!(status, StatusCode::CREATED);

  let mut read = String::new();

  while !read.contains("\n\n") {
    let chunk = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
      .await
      .unwrap()
      .unwrap()
      .unwrap();

    read.push_str(&String::from_utf8_lossy(&chunk));
  }

  assert!(read.contains("event: judgement.created"), "{read}");
  assert!(read.contains("\"verdict\":\"SKIP\""), "{read}");
}

#[tokio::test]
async fn no_gate_stands_and_no_run_of_one_is_served() {
  let ground = ground("voice", |_| None).await;
  let (status, body) = ground.get("/gates").await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body["items"], json!([]));

  for gate in ["output-format", "session-summary", "no-such-gate"] {
    let (status, body) = ground
      .post(&format!("/stages/{gate}/runs"), json!({ "prompt": "Read this aloud." }))
      .await;

    assert_eq!(status, StatusCode::NOT_FOUND, "{gate}: {body}");
    refused(&body, "no-gate");
  }
}
