//! The watches the service keeps beside its routes, as the agency sees them: its road events are read, and no hook
//! is registered at any of its points, `session-summariser` among them, nor answered by a route of the gate's; and
//! as the receiver sees them: the draft rows its event stream tells are written as the `draft` stage, once each,
//! under the round's message where the round has one.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gate_ports::Peer;
use gate_ports::agency::HttpAgency;
use gate_ports::receiver::{Drafted, HttpReceiver, Receiver};
use gate_reference::Reference;
use gate_runs::Runs;
use gate_server::App;
use gate_stages::document_translation::Queue;
use gate_stages::translator::Intake;
use gate_stages::{Reading, Stages};
use reqwest::StatusCode;
use serde_json::json;

use crate::fakes::{AnsweringGateway, FakeBrain, FakeReceiver};
use crate::stub::Stub;
use crate::{ROOM, TOKEN, ground};

// The service's routes and watches over the agency `stub` stands in for over HTTP, and over `receiver`.
fn app_on(ground: &crate::Ground, stub: &Stub, receiver: Arc<dyn Receiver>) -> Arc<App> {
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
  let stages = Arc::new(Stages::new(runs, Reading::default()));

  Arc::new(App {
    stages: stages.clone(),
    reference: Arc::new(Reference {
      stages,
      brain: Arc::new(FakeBrain::default()),
      receiver,
      shipped: None,
    }),
    queue: Queue::default(),
    translations: Intake::of_policy(),
    token: TOKEN.to_owned(),
    data_root: PathBuf::from(&ground.app.data_root),
  })
}

#[tokio::test]
async fn the_watches_read_the_agencys_road_events_and_register_no_hook() {
  let ground = ground("no-hook", |_| None).await;
  let stub = Stub::start().await;

  gate_server::watches::start(app_on(&ground, &stub, Arc::new(FakeReceiver::default())));

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

// One row of round `round-1`'s draft process in the tests' room.
fn drafted(number: i64, question: &str, kind: &str, outcome: &str, detail: Option<&str>) -> Drafted {
  Drafted {
    chat_id: ROOM,
    round: "round-1".into(),
    agent_name: "the-chat-agent".into(),
    number,
    question: question.into(),
    kind: kind.into(),
    answer_chars: 40 * number,
    changed: number % 2 == 1,
    outcome: outcome.into(),
    detail: detail.map(str::to_owned),
    ms: 1_000 + number,
  }
}

// The receiver's frame telling one draft row, as its stream writes one.
fn frame(id: i64, row: &Drafted) -> String {
  let mut data = serde_json::to_value(row).unwrap();

  data["type"] = json!("draft");
  data["messageId"] = json!(null);
  data["id"] = json!(id);
  data["at"] = json!(1_700_000_000);

  format!("id: {id}\nevent: bot\ndata: {data}\n\n")
}

#[tokio::test]
async fn the_receivers_draft_rows_are_written_as_the_draft_stage_under_the_rounds_message() {
  let ground = ground("draft-stage", |_| None).await;
  let agency = Stub::start().await;
  let receiver = Stub::start().await;
  let peer = Peer::new(&receiver.address, Some("the-receiver-token".to_owned())).unwrap();
  let rows = [
    drafted(0, "", "turn", "answered", None),
    drafted(1, "intent", "question", "answered", None),
    drafted(2, "final", "question", "answered", None),
    drafted(3, "length", "check", "answered", None),
    drafted(4, "", "end", "message", Some("*/*/*")),
  ];
  let mut body = "event: run\ndata: {\"run\":\"a-run\"}\n\n".to_owned();

  for (at, row) in rows.iter().enumerate() {
    body.push_str(&frame(at as i64 + 1, row));
  }

  receiver.canned(reqwest::Method::GET, "/events", 200, "text/event-stream", body);

  let (status, sent) = ground
    .post(
      "/judgements",
      json!({ "roomId": ROOM, "messageId": 40, "gateName": "send", "verdict": "SENT", "round": "round-1" }),
    )
    .await;

  assert_eq!(status, StatusCode::CREATED, "{sent}");

  let app = app_on(&ground, &agency, Arc::new(HttpReceiver::new(peer)));
  let mut heard = app.stages.events.subscribe();

  gate_server::watches::start(app);

  let count = || ground.scratch.count(r#"SELECT count(*) FROM judgements WHERE stage = 'draft'"#, vec![]);
  let mut waited = Duration::ZERO;

  while count().await < 5 && waited < Duration::from_secs(10) {
    tokio::time::sleep(Duration::from_millis(50)).await;
    waited += Duration::from_millis(50);
  }

  let (status, page) = ground.get(&format!("/judgements?roomId={ROOM}&gateName=draft")).await;

  assert_eq!(status, StatusCode::OK, "{page}");

  let mut items = page["items"].as_array().unwrap().clone();

  items.reverse();

  let verdicts: Vec<&str> = items.iter().map(|item| item["verdict"].as_str().unwrap()).collect();

  assert_eq!(
    verdicts,
    [
      "ROUND 0 turn: answered",
      "ROUND 1 intent: answered",
      "ROUND 2 final: answered",
      "ROUND 3 length: answered",
      "END: message"
    ]
  );
  assert!(items.iter().all(|item| item["messageId"] == 40 && item["round"] == "round-1"), "{page}");
  assert_eq!(items[1]["detail"], "answerChars=40 changed=true ms=1001");
  assert_eq!(items[2]["detail"], "answerChars=80 changed=false ms=1002");
  assert_eq!(items[4]["detail"], "answerChars=160 changed=false ms=1004; */*/*");
  assert_eq!(items[4]["ms"], 1004);
  let told = std::iter::from_fn(|| heard.try_recv().ok())
    .filter(|event| event.kind == "judgement.created")
    .count();

  assert_eq!(told, 5);
  assert_eq!(receiver.one("/events").bearer().as_deref(), Some("the-receiver-token"));
}

#[tokio::test]
async fn a_draft_row_is_written_once_whatever_its_kind_and_a_round_with_no_message_stands_under_none() {
  let ground = ground("draft-once", |_| None).await;
  let agency = Stub::start().await;
  let app = app_on(&ground, &agency, Arc::new(FakeReceiver::default()));
  let skipped = drafted(1, "intent", "question", "skip", None);

  gate_server::watches::write_drafted(&app, &skipped).await;
  gate_server::watches::write_drafted(&app, &skipped).await;
  gate_server::watches::write_drafted(&app, &drafted(5, "", "a-kind-to-come", "answered", None)).await;

  let rows = ground
    .scratch
    .texts(
      r#"SELECT verdict || '|' || coalesce(message_id::text, 'none') || '|' || round FROM judgements
         WHERE stage = 'draft' ORDER BY id"#,
      vec![],
    )
    .await;

  assert_eq!(
    rows,
    ["ROUND 1 intent: skip|none|round-1", "ROUND 5 a-kind-to-come: answered|none|round-1"]
  );
}
