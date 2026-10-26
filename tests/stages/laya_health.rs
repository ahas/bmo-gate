//! Laya's health: a failed check keeps what the server last said, only an answer with its model and device is up,
//! a status reads as the failure it stands for, the token counts only from a private file, and a pass writes the
//! one row and says whether the state or the model moved.

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;

use axum::http::{Method, StatusCode};
use gate_stages::laya::Side;
use gate_stages::laya_health::{
  Health, Outcome, Report, failure_of, next_health, pass, read, report_of, token,
};
use serde_json::json;

use crate::scratch::Scratch;
use crate::stub::Stub;
use crate::token_file;

fn report(model: &str) -> Report {
  Report {
    model: model.to_owned(),
    device: "cuda:0".to_owned(),
    vram_bytes: Some(1024),
    load_ms: Some(80),
    versions: BTreeMap::from([("torch".to_owned(), "2.6".to_owned())]),
    ms: 12,
  }
}

#[test]
fn a_failed_check_keeps_what_the_server_last_said_and_when_it_last_answered() {
  let up =
    next_health(&Health::unknown(), Outcome::Up(report("laya-1")), 100, Some("http://laya".to_owned()));

  assert_eq!(up.state, "up");
  assert_eq!((up.checked_at, up.healthy_at, up.check_ms), (Some(100), Some(100), Some(12)));

  let down = next_health(&up, Outcome::Down("timeout"), 160, Some("http://laya".to_owned()));

  assert_eq!(down.state, "timeout");
  assert_eq!(down.model.as_deref(), Some("laya-1"));
  assert_eq!(down.versions, up.versions);
  assert_eq!((down.checked_at, down.healthy_at, down.check_ms), (Some(160), Some(100), None));
}

#[test]
fn a_server_answering_while_its_card_is_taken_reads_busy_and_answered() {
  let busy =
    next_health(&Health::unknown(), Outcome::Busy(report("laya-1")), 100, Some("http://laya".to_owned()));

  assert_eq!(busy.state, "busy");
  assert_eq!((busy.model.as_deref(), busy.healthy_at), (Some("laya-1"), Some(100)));
}

#[test]
fn an_answer_counts_only_as_up_with_its_model_and_device() {
  let body = json!({
    "state": "up", "model": "laya-1", "device": "cuda:0", "vramBytes": 1024.4, "loadMs": 79.6,
    "versions": { "torch": "2.6", "odd": 3 },
  });
  let read = report_of(&body, 5).unwrap();

  assert_eq!((read.vram_bytes, read.load_ms), (Some(1024), Some(80)));
  assert_eq!(read.versions, BTreeMap::from([("torch".to_owned(), "2.6".to_owned())]));
  assert_eq!(report_of(&json!({ "state": "loading", "model": "m", "device": "d" }), 5), None);
  assert_eq!(report_of(&json!({ "state": "up", "device": "d" }), 5), None);
}

#[test]
fn a_status_reads_as_the_failure_it_stands_for() {
  assert_eq!(failure_of(StatusCode::GATEWAY_TIMEOUT), "timeout");
  assert_eq!(failure_of(StatusCode::SERVICE_UNAVAILABLE), "unreachable");
  assert_eq!(failure_of(StatusCode::INTERNAL_SERVER_ERROR), "bad-answer");
  assert_eq!(failure_of(StatusCode::UNAUTHORIZED), "refused");
}

#[test]
fn the_token_counts_only_while_its_file_is_private_and_holds_one() {
  let file = token_file("token");

  std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
  assert_eq!(token(&file), None);
  std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
  assert_eq!(token(&file).as_deref(), Some("relay-token"));
  std::fs::write(&file, "  \n").unwrap();
  assert_eq!(token(&file), None);
}

#[tokio::test]
async fn a_pass_writes_the_one_row_and_says_whether_the_state_or_the_model_moved() {
  let scratch = Scratch::new().await;
  let stub = Stub::start().await;
  let side =
    Side::new(scratch.db().clone(), Some(&format!("{}/", stub.address)), Some(token_file("pass")), "a");

  stub.answer(
    Method::GET,
    "/health",
    200,
    json!({ "state": "up", "model": "output-format=/w/a", "device": "cuda:0", "versions": { "torch": "2.6" } }),
  );

  assert_eq!(read(scratch.db()).await.unwrap().state, "unknown");
  assert!(pass(scratch.db(), &side, 100).await.unwrap());
  assert!(!pass(scratch.db(), &side, 160).await.unwrap());

  let health = read(scratch.db()).await.unwrap();

  assert_eq!((health.state.as_str(), health.model.as_deref()), ("up", Some("output-format=/w/a")));
  assert_eq!(health.address.as_deref(), Some(stub.address.as_str()));
  assert_eq!(stub.seen()[0].bearer().as_deref(), Some("relay-token"));
  assert_eq!(scratch.count("SELECT count(*) FROM laya_health", vec![]).await, 1);

  let off = Side::new(scratch.db().clone(), None, None, "a");

  assert!(pass(scratch.db(), &off, 200).await.unwrap());
  assert_eq!(read(scratch.db()).await.unwrap().state, "off");
}
