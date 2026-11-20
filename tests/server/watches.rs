//! The watches the service keeps beside its routes, as the agency sees them: its road events are read, and no hook
//! is registered at any of its points, `session-summariser` among them, nor answered by a route of the gate's; and
//! as the receiver sees them: the draft rows its event stream tells are written as the `draft` stage, once each,
//! under the round's message where the round has one; and the agency's roads are written with their numbers, the
//! stream read on from the newest written each time it is opened.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gate_ports::Peer;
use gate_ports::accounts::NoAccounts;
use gate_ports::agency::HttpAgency;
use gate_ports::receiver::{Drafted, HttpReceiver, Receiver};
use gate_reference::Reference;
use gate_runs::Runs;
use gate_server::App;
use gate_server::stop::Stop;
use gate_stages::document_translation::Queue;
use gate_stages::translator::Intake;
use gate_stages::{Reading, Stages};
use reqwest::StatusCode;
use serde_json::json;

use super::{ROOM, TOKEN, ground};
use crate::reference::fakes::{AnsweringGateway, FakeBrain, FakeReceiver};
use crate::support::agency::StandInAgency;
use crate::support::stub::Stub;

// The service's routes and watches over the agency standing in at `agency` over HTTP, and over `receiver`.
fn app_on(ground: &super::Ground, agency: &str, receiver: Arc<dyn Receiver>) -> Arc<App> {
  let peer = Peer::new(agency, Some("the-agency-token".to_owned())).unwrap();
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
      accounts: Arc::new(NoAccounts),
      receiver,
      shipped: None,
    }),
    queue: Queue::default(),
    translations: Intake::of_policy(),
    token: TOKEN.to_owned(),
    data_root: PathBuf::from(&ground.app.data_root),
    stop: Stop::default(),
  })
}

#[tokio::test]
async fn the_watches_read_the_agencys_road_events_and_register_no_hook() {
  let ground = ground("no-hook", |_| None).await;
  let stub = Stub::start().await;

  gate_server::watches::start(app_on(&ground, &stub.address, Arc::new(FakeReceiver::default())), REOPEN);

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

// How long a dropped stream waits before it is opened again, in the tests.
const REOPEN: Duration = Duration::from_millis(20);

// Waits until `holds` answers true, ten seconds at most, and says whether it did.
async fn until<F: std::future::Future<Output = bool>>(mut holds: impl FnMut() -> F) -> bool {
  let mut waited = Duration::ZERO;

  while waited < Duration::from_secs(10) {
    if holds().await {
      return true;
    }

    tokio::time::sleep(Duration::from_millis(20)).await;
    waited += Duration::from_millis(20);
  }

  false
}

// The agency's frame telling one road of the tests' room under its event's number.
fn road_frame(event: i64, run: &str) -> String {
  let road = json!({
    "stage": "chat", "chatId": ROOM, "run": run, "provider": "a-provider", "model": "a-model", "outcome": "answered",
    "ms": 900, "inputTokens": 3, "outputTokens": 4, "cacheReadTokens": null, "cacheWriteTokens": null,
    "contextRatio": null
  });
  let data = json!({ "id": event, "kind": "road-walked", "at": 1, "data": road });

  format!("id: {event}\nevent: road-walked\ndata: {data}\n\n")
}

#[tokio::test]
async fn the_agencys_roads_are_written_once_each_and_read_on_from_the_newest_written() {
  let ground = ground("roads-read-on", |_| None).await;
  let agency = Stub::start().await;

  ground
    .scratch
    .run(
      r#"INSERT INTO gate_roads (stage, provider, model, outcome, ms, created_at, run, event)
         VALUES ('chat', 'a-provider', 'a-model', 'answered', 1, 1, 'turn:5', 5)"#,
      vec![],
    )
    .await
    .unwrap();
  // The stream ends after its frames, as one the agency's stop cuts does, and is opened again.
  agency.canned(
    reqwest::Method::GET,
    "/events",
    200,
    "text/event-stream",
    [road_frame(5, "turn:5"), road_frame(6, "turn:6"), road_frame(7, "turn:7")].concat(),
  );

  gate_server::watches::start(app_on(&ground, &agency.address, Arc::new(FakeReceiver::default())), REOPEN);

  let opened = || agency.seen().into_iter().filter(|seen| seen.path == "/events").collect::<Vec<_>>();

  assert!(until(|| async { opened().len() >= 2 }).await, "{:?}", agency.seen());

  let opened = opened();
  let runs = ground
    .scratch
    .texts(
      r#"SELECT run || ':' || event FROM gate_roads WHERE event IS NOT NULL ORDER BY event"#,
      vec![],
    )
    .await;

  assert_eq!(opened[0].header("last-event-id").as_deref(), Some("5"));
  assert_eq!(opened[1].header("last-event-id").as_deref(), Some("7"));
  assert_eq!(runs, ["turn:5:5", "turn:6:6", "turn:7:7"]);
}

#[tokio::test]
async fn roads_after_a_number_the_agency_never_gave_are_written_whatever_their_number() {
  let ground = ground("roads-numbering-behind", |_| None).await;
  let agency = Stub::start().await;

  ground
    .scratch
    .run(
      r#"INSERT INTO gate_roads (stage, provider, model, outcome, ms, created_at, run, event)
         VALUES ('chat', 'a-provider', 'a-model', 'answered', 1, 1, 'turn:900', 900)"#,
      vec![],
    )
    .await
    .unwrap();

  let missed = json!({ "kind": "events.missed", "at": 1, "data": { "after": 900, "keptFrom": 10 } });

  agency.canned(
    reqwest::Method::GET,
    "/events",
    200,
    "text/event-stream",
    format!("event: events.missed\ndata: {missed}\n\n{}", road_frame(12, "turn:12")),
  );

  gate_server::watches::start(app_on(&ground, &agency.address, Arc::new(FakeReceiver::default())), REOPEN);

  let written = || ground.scratch.count(r#"SELECT count(*) FROM gate_roads WHERE event = 12"#, vec![]);

  assert!(until(|| async { written().await == 1 }).await, "{:?}", agency.seen());
}

#[tokio::test]
async fn the_roads_walked_while_the_agency_restarts_are_written_once_the_stream_is_opened_again() {
  let ground = ground("roads-agency-restart", |_| None).await;
  let agency = StandInAgency::start().await;
  let written = || async {
    ground
      .scratch
      .texts(
        r#"SELECT run || ':' || event FROM gate_roads WHERE event IS NOT NULL ORDER BY event"#,
        vec![],
      )
      .await
  };

  gate_server::watches::start(
    app_on(&ground, &agency.address(), Arc::new(FakeReceiver::default())),
    REOPEN,
  );

  assert!(until(|| async { agency.opened().len() == 1 }).await);
  agency.publish_road(1, ROOM, "turn:1");
  agency.publish_road(2, ROOM, "turn:2");
  assert!(until(|| async { written().await.len() == 2 }).await, "{:?}", written().await);

  // The agency stops in the middle of the stream: the connection is cut, and the roads of the turns that end
  // while it is down are kept by it and published to nobody.
  agency.stop().await;
  agency.publish_road(3, ROOM, "turn:3");
  agency.publish_road(4, ROOM, "turn:4");
  agency.start_again().await;

  assert!(until(|| async { agency.opened().len() == 2 }).await, "{:?}", agency.opened());
  agency.publish_road(5, ROOM, "turn:5");
  assert!(until(|| async { written().await.len() == 5 }).await, "{:?}", written().await);

  assert_eq!(agency.opened(), [None, Some("2".to_owned())]);
  assert_eq!(written().await, ["turn:1:1", "turn:2:2", "turn:3:3", "turn:4:4", "turn:5:5"]);
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

  let app = app_on(&ground, &agency.address, Arc::new(HttpReceiver::new(peer)));
  let mut heard = app.stages.events.subscribe();

  gate_server::watches::start(app, REOPEN);

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
  assert!(
    receiver
      .seen()
      .iter()
      .filter(|seen| seen.path == "/events")
      .all(|seen| seen.bearer().as_deref() == Some("the-receiver-token")),
    "{:?}",
    receiver.seen()
  );
}

#[tokio::test]
async fn a_draft_row_is_written_once_whatever_its_kind_and_a_round_with_no_message_stands_under_none() {
  let ground = ground("draft-once", |_| None).await;
  let agency = Stub::start().await;
  let app = app_on(&ground, &agency.address, Arc::new(FakeReceiver::default()));
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
