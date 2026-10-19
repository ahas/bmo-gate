//! The bmo-job port: a row raised, and a bmo-job that serves no such route yet refusing it as a refusal.

use axum::http::Method;
use gate_ports::job::{HttpJob, Job};
use serde_json::json;

use crate::peer;
use crate::stub::Stub;

#[tokio::test]
async fn a_row_is_raised_with_its_title_its_judgement_and_its_room() {
  let stub = Stub::start().await;
  let job = HttpJob::new(peer(&stub, "job-token"));

  stub.answer(Method::POST, "/todos/raised", 200, json!({ "id": 1900 }));

  let raised = job.raise("A piece attaches too often", "It attached on most turns.", 7).await.unwrap();

  assert_eq!(raised, 1900);
  assert_eq!(
    stub.one("/todos/raised").json(),
    json!({ "title": "A piece attaches too often", "judgement": "It attached on most turns.", "chat": 7 })
  );
  assert_eq!(stub.one("/todos/raised").bearer().as_deref(), Some("job-token"));
}

#[tokio::test]
async fn a_bmo_job_that_serves_no_such_route_refuses_it_as_a_refusal() {
  let stub = Stub::start().await;

  let refused = HttpJob::new(peer(&stub, "t")).raise("A title", "A judgement.", 7).await.unwrap_err();

  assert_eq!(refused.refused_with(), Some("route_absent"));
}
