//! Translations: kept translations read and kept, and originals translated.

use reqwest::StatusCode;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{ground, refused};

// A Korean greeting, as a worker's record holds it.
const GREETING: &str = "\u{c548}\u{b155}\u{d558}\u{c138}\u{c694}";

// The digest an original is read back by.
fn digest(original: &str) -> String {
  format!("{:x}", Sha256::digest(original.as_bytes()))
}

#[tokio::test]
async fn a_kept_translation_is_read_back_by_its_digest_and_never_asks_the_translator() {
  let ground = ground("kept", |_| None).await;
  // A title holding commas, which the digest names whole.
  let original = format!("{GREETING}, {GREETING}, {GREETING}");
  let kept = format!("/translations/kept?language=en&digests={},{}", digest(&original), digest("unkept"));
  let (status, body) = ground.get(&kept).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body, json!({ "items": [], "more": false }));

  let (status, body) = ground
    .put(
      "/translations/kept",
      json!({ "language": "en", "original": original, "text": "Hello, hello, hello." }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body, json!({ "original": original, "text": "Hello, hello, hello." }));

  let (status, body) = ground.get(&kept).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(
    body,
    json!({ "items": [{ "digest": digest(&original), "text": "Hello, hello, hello." }], "more": false })
  );
  assert!(ground.gateway.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_digest_not_of_its_shape_is_refused() {
  let ground = ground("digest", |_| None).await;
  let (status, body) = ground.get(&format!("/translations/kept?language=en&digests={GREETING}")).await;

  assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
  refused(&body, "bad-request");
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
async fn an_english_original_is_read_into_each_language_a_person_reads_the_console_in() {
  for (language, name) in [("ja", "Japanese"), ("zh-CN", "Simplified Chinese")] {
    let ground = ground(&format!("console-{language}"), |_| None).await;

    ground.agency.translated.lock().unwrap().push_back("A reading.".to_owned());

    let (status, body) = ground
      .post(
        "/translations",
        json!({ "language": language, "originals": ["The build finished and the release is live."] }),
      )
      .await;

    assert_eq!(status, StatusCode::OK, "{language}: {body}");
    assert_eq!(body["readings"][0]["whole"], json!(true), "{language}: {body}");
    assert_eq!(body["readings"][0]["text"], json!("A reading."), "{language}: {body}");

    {
      let asked = ground.agency.translations.lock().unwrap();

      assert_eq!(asked.len(), 1);
      assert_eq!((asked[0].purpose.as_str(), asked[0].language.as_str()), ("document", name));
    }

    let (status, body) = ground.get(&format!("/translations/kept?language={language}&digests=")).await;

    assert_eq!(status, StatusCode::OK, "{language}: {body}");
  }
}

#[tokio::test]
async fn a_language_no_reader_takes_is_refused() {
  let ground = ground("language", |_| None).await;

  for (path, body) in [
    ("/translations", json!({ "language": "fr", "originals": ["Bonjour."] })),
    ("/translations/kept?language=fr&digests=", json!({})),
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
