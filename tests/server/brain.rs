//! bmo-brain's calls, with the camelCase bodies its gate port sends: a document's sanitising, and a person-book
//! sheet's judgement; a body that is not as asked refused in the brain's kebab-case.

use reqwest::StatusCode;
use serde_json::json;

use crate::{ROOM, ground, refused};

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
  assert_eq!(body, json!({ "answered": true, "text": "Likes tea in the morning." }));
}

#[tokio::test]
async fn a_sheet_is_written_from_the_pieces_handed_in() {
  let ground = ground("sheet", |_| Some("Likes tea in the morning.".into())).await;
  let ask = |pieces| {
    json!({
      "agent": "the-chat-agent",
      "part": "room",
      "chatId": ROOM,
      "person": 5,
      "pieces": pieces,
      "ceiling": 2000,
      "registration": null,
    })
  };
  let (status, body) = ground
    .post(
      "/sheets/judge",
      ask(json!([{ "path": "people/5/likes.md", "text": "Likes tea in the morning." }])),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body, json!({ "sheet": "Likes tea in the morning." }));

  let (status, body) = ground.post("/sheets/judge", ask(json!([]))).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body, json!({ "sheet": null }));
}

#[tokio::test]
async fn a_brain_body_not_as_asked_is_refused_in_kebab_case() {
  let ground = ground("brain-wrong", |_| None).await;
  let (status, body) =
    ground.post("/sheets/judge", json!({ "agent": "the-chat-agent", "part": "both" })).await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&body, "field-wrong");
}
