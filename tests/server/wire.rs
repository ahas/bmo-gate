//! The wire every family shares: the bearer token, a route that is not there, a body that is not JSON or not as
//! asked, the health, the event stream, the output gate a chat unit asks, and one run of a voice gate.

use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::json;

use crate::{ROOM, TOKEN, ground, refused};

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

  for (status, body) in [ground.get("/nowhere").await, ground.get("/judgements").await] {
    assert_eq!(status, StatusCode::NOT_FOUND);
    refused(&body, "route_absent");
  }
}

#[tokio::test]
async fn a_body_not_json_or_not_as_asked_is_refused() {
  let ground = ground("body", |_| None).await;
  let response = ground
    .client
    .post(format!("{}/sanitised", ground.address))
    .bearer_auth(TOKEN)
    .header("content-type", "application/json")
    .body("{ not json")
    .send()
    .await
    .unwrap();

  assert_eq!(response.status(), StatusCode::BAD_REQUEST);
  refused(&response.json().await.unwrap(), "body_not_json");

  let (status, body) = ground.post("/sanitised", json!({ "label": "a room's message" })).await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&body, "field_wrong");
}

#[tokio::test]
async fn the_health_says_the_version_the_database_and_laya() {
  let ground = ground("health", |_| None).await;
  let (status, body) = ground.get("/health").await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body["version"], gate_server::routes::health::bmo_version());
  assert_eq!(body["ready"], true);
  assert!(["up", "down", "off"].contains(&body["laya"].as_str().unwrap()), "{body}");
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
    .post("/judgements", json!({ "chat": ROOM, "stage": "chat", "verdict": "SKIP" }))
    .await;

  assert_eq!(status, StatusCode::NO_CONTENT);

  let mut read = String::new();

  while !read.contains("\n\n") {
    let chunk = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
      .await
      .unwrap()
      .unwrap()
      .unwrap();

    read.push_str(&String::from_utf8_lossy(&chunk));
  }

  assert!(read.contains("event: judgement"), "{read}");
  assert!(read.contains("\"verdict\":\"SKIP\""), "{read}");
}

#[tokio::test]
async fn a_part_of_a_reply_is_answered_with_the_markup_it_goes_out_as() {
  let ground = ground("formats", |_| None).await;
  let (status, body) = ground
    .post("/formats/decided", json!({ "chat": ROOM, "text": "Plain words, **one** bold." }))
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert!(body.as_object().unwrap().contains_key("markup"), "{body}");
  assert!(body["markup"].is_null() || body["markup"].is_string());
}

#[tokio::test]
async fn one_run_of_a_voice_gate_answers_on_its_road() {
  let ground = ground("voice", |ask| (!ask.system.is_empty()).then(|| "Read slowly.".into())).await;
  let (status, body) = ground
    .post("/stages/voice-reading/runs", json!({ "prompt": "Read this aloud.", "chat": ROOM }))
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body["answer"], "Read slowly.");
  assert!(body["ms"].is_i64());

  let (status, body) =
    ground.post("/stages/no-such-gate/runs", json!({ "prompt": "Read this aloud." })).await;

  assert_eq!(status, StatusCode::NOT_FOUND);
  refused(&body, "no_gate");
}

#[tokio::test]
async fn a_voice_gate_switched_off_answers_nothing_and_asks_no_road() {
  let ground = ground("voice-off", |_| Some("Read slowly.".into())).await;
  let (status, _) = ground.post("/options/voice-polish", json!({ "enabled": false })).await;

  assert_eq!(status, StatusCode::OK);

  let (status, body) = ground
    .post(
      "/stages/voice-polish/runs",
      json!({ "prompt": "Polish this.", "system": "Polish it.", "thinking": false, "alongside": true }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body, json!({ "answer": null, "ms": 0 }));
  assert!(ground.gateway.asked.lock().unwrap().is_empty());
}
