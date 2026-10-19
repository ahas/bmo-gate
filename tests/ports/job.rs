//! The bmo-job port: a row raised, and a bmo-job that serves no such route yet refusing it as a refusal.

use axum::http::Method;
use gate_ports::job::{HttpJob, Job, Raised};
use serde_json::json;

use crate::peer;
use crate::stub::Stub;

#[tokio::test]
async fn a_row_is_raised_with_its_title_its_judgement_its_room_and_its_key() {
  let stub = Stub::start().await;
  let job = HttpJob::new(peer(&stub, "job-token"));

  stub.answer(Method::POST, "/todos/raised", 200, json!({ "id": 1900, "raised": false }));

  let raised = job
    .raise("A piece attaches too often", "It attached on most turns.", 7, "a-gate:a-piece")
    .await
    .unwrap();

  assert_eq!(
    raised,
    Raised {
      id: 1900,
      raised: false
    }
  );
  assert_eq!(
    stub.one("/todos/raised").json(),
    json!({
      "title": "A piece attaches too often", "judgement": "It attached on most turns.", "chat": 7, "key": "a-gate:a-piece"
    })
  );
  assert_eq!(stub.one("/todos/raised").bearer().as_deref(), Some("job-token"));
}

#[tokio::test]
async fn a_bmo_job_that_serves_no_such_route_refuses_it_as_a_refusal() {
  let stub = Stub::start().await;

  let refused = HttpJob::new(peer(&stub, "t"))
    .raise("A title", "A judgement.", 7, "k")
    .await
    .unwrap_err();

  assert_eq!(refused.refused_with(), Some("route_absent"));
}
