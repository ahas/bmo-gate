//! The watches the service keeps beside its routes, as the agency sees them: its road events are read, and no hook
//! is registered at any of its points, `session-summariser` among them, nor answered by a route of the gate's.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gate_ports::Peer;
use gate_ports::agency::HttpAgency;
use gate_reference::Reference;
use gate_runs::Runs;
use gate_server::App;
use gate_stages::document_translation::Queue;
use gate_stages::laya::Side;
use gate_stages::{Reading, Stages};
use reqwest::StatusCode;
use serde_json::json;

use crate::fakes::{AnsweringGateway, FakeBrain, FakeJob, FakeReceiver};
use crate::stub::Stub;
use crate::{TOKEN, ground};

// The service's routes and watches over the agency `stub` stands in for over HTTP.
fn app_on(ground: &crate::Ground, stub: &Stub) -> Arc<App> {
  let peer = Peer::new(&stub.address, Some("the-agency-token".to_owned())).unwrap();
  let gateway = Arc::new(AnsweringGateway {
    answer: Box::new(|_| None),
    asked: Default::default(),
  });
  let runs = Runs::new(
    ground.scratch.db().clone(),
    Arc::new(HttpAgency::new(peer)),
    gateway,
    "the-chat-agent",
    "/a/folder",
  );
  let side = Side::new(ground.scratch.db().clone(), None, None, "the-chat-agent");
  let stages = Arc::new(Stages::new(runs, side, Reading::default()));

  Arc::new(App {
    stages: stages.clone(),
    reference: Arc::new(Reference {
      stages,
      brain: Arc::new(FakeBrain::default()),
      receiver: Arc::new(FakeReceiver::default()),
      shipped: None,
    }),
    job: Arc::new(FakeJob::default()),
    queue: Queue::default(),
    token: TOKEN.to_owned(),
    owner_room: 1,
    data_root: PathBuf::from(&ground.app.data_root),
    console: None,
  })
}

#[tokio::test]
async fn the_watches_read_the_agencys_road_events_and_register_no_hook() {
  let ground = ground("no-hook", |_| None).await;
  let stub = Stub::start().await;

  gate_server::watches::start(app_on(&ground, &stub));

  let mut waited = Duration::ZERO;

  while !stub.seen().iter().any(|seen| seen.path == "/events") && waited < Duration::from_secs(10) {
    tokio::time::sleep(Duration::from_millis(50)).await;
    waited += Duration::from_millis(50);
  }

  tokio::time::sleep(Duration::from_millis(500)).await;

  let seen = stub.seen();

  assert!(seen.iter().any(|seen| seen.path == "/events"), "{seen:?}");
  assert!(!seen.iter().any(|seen| seen.path.starts_with("/hooks")), "{seen:?}");
}

#[tokio::test]
async fn the_session_summariser_point_is_no_route() {
  let ground = ground("no-hook-route", |_| None).await;
  let (status, _) = ground
    .post(
      "/hooks/session-summariser",
      json!({ "point": "session-summariser", "ask": { "kind": "chat" } }),
    )
    .await;

  assert_eq!(status, StatusCode::NOT_FOUND);
}
