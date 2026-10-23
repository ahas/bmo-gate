//! A document's sanitising; a body that is not as asked refused in the common shape.

use reqwest::StatusCode;
use serde_json::json;

use crate::{ground, refused};

#[tokio::test]
async fn a_document_with_nothing_worth_judging_is_kept_as_it_is() {
  let ground = ground("document", |_| None).await;
  let (status, body) = ground
    .post(
      "/sanitiser/documents",
      json!({ "path": "people/5/likes.md", "text": "Likes tea in the morning." }),
    )
    .await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body, json!({ "text": "Likes tea in the morning." }));
}

#[tokio::test]
async fn a_body_not_as_asked_is_refused_in_the_common_shape() {
  let ground = ground("brain-wrong", |_| None).await;
  let (status, body) = ground.post("/sanitiser/documents", json!({ "path": "people/5/likes.md" })).await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&body, "bad-request");
}
