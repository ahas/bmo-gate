//! Translations: kept translations read and kept, and originals translated.

use reqwest::StatusCode;
use serde_json::json;

use super::{ground, refused};

// A Korean greeting, as a worker's record holds it.
const GREETING: &str = "\u{c548}\u{b155}\u{d558}\u{c138}\u{c694}";

#[tokio::test]
async fn a_kept_translation_is_read_back_and_never_asks_the_translator() {
  let ground = ground("kept", |_| None).await;
  let (status, body) = ground.get(&format!("/translations/kept?language=en&originals={GREETING}")).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body, json!({ "items": [], "more": false }));

  let (status, body) = ground
    .put(
      "/translations/kept",
      json!({ "language": "en", "original": GREETING, "text": "Hello." }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body, json!({ "original": GREETING, "text": "Hello." }));

  let (status, body) = ground.get(&format!("/translations/kept?language=en&originals={GREETING}")).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body, json!({ "items": [{ "original": GREETING, "text": "Hello." }], "more": false }));
  assert!(ground.gateway.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn originals_are_read_in_the_language_asked_in_their_order() {
  let ground = ground("translations", |_| Some("Hello.".into())).await;
  let (status, body) = ground
    .post(
      "/translations",
      json!({ "language": "en", "originals": ["Already English.", GREETING] }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");

  let readings = body["readings"].as_array().unwrap();

  assert_eq!(readings.len(), 2);
  assert_eq!(readings[0], json!({ "text": "Already English.", "whole": true }));
  assert!(readings[1]["text"].is_string() && readings[1]["whole"].is_boolean());
}

#[tokio::test]
async fn a_language_no_reader_takes_is_refused() {
  let ground = ground("language", |_| None).await;

  for (path, body) in [
    ("/translations", json!({ "language": "fr", "originals": ["Bonjour."] })),
    ("/translations/kept?language=fr&originals=", json!({})),
  ] {
    let (status, body) = if path.starts_with("/translations/kept") {
      ground.get(path).await
    } else {
      ground.post(path, body).await
    };

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    refused(&body, "language-unknown");
  }

  let (status, body) = ground
    .put("/translations/kept", json!({ "language": "fr", "original": "a", "text": "b" }))
    .await;

  assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
  refused(&body, "language-unknown");
}
