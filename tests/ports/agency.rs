//! The agency port: the providers, a role's provider order, a thrown-away session and its one turn, a translation
//! run asked until the agency answers it, and the roads walked, read on from a number.

use std::time::Duration;

use axum::http::Method;
use futures_util::StreamExt;
use gate_ports::agency::{Agency, Apart, GateTurn, HttpAgency, Line, RoadEvent, TranslationAsk};
use gate_ports::http::Patience;
use gate_ports::{Peer, PortError};
use serde_json::json;

use super::peer;
use crate::support::stub::Stub;
use crate::support::turns::{Step, Turns};

#[tokio::test]
async fn the_reads_answer_the_providers_and_a_role() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "control-token"));

  stub.answer(
    Method::GET,
    "/providers",
    200,
    json!({ "items": [{ "name": "claude-code", "enabled": true, "registered": false, "coworker": true, "lines": ["gate"] }] }),
  );
  stub.answer(
    Method::GET,
    "/roles/a-gate-role",
    200,
    json!({
      "name": "a-gate-role", "code": "a-gate-role", "label": "A gate role", "line": "worker", "maxConcurrent": 2,
      "order": [
        { "provider": "claude-code", "model": "a-model", "effort": "low", "thinking": null },
        { "provider": "registry", "model": "a-registration", "effort": null, "thinking": "on", "answerTokens": 2048 }
      ],
      "quotaShare": 0.01, "provider": "claude-code", "running": 0, "waiting": 0
    }),
  );

  let providers = agency.providers().await.unwrap();
  let role = agency.role("a-gate-role").await.unwrap().unwrap();

  assert_eq!(providers[0].lines, vec!["gate"]);
  assert_eq!(role.provider.as_deref(), Some("claude-code"));
  assert_eq!(role.order[0].model, "a-model");
  assert_eq!(role.order[0].effort.as_deref(), Some("low"));
  assert_eq!(role.order[1].thinking.as_deref(), Some("on"));
  assert_eq!(role.order[1].answer_tokens, Some(2048));
  assert_eq!(stub.one("/providers").bearer().as_deref(), Some("control-token"));
}

#[tokio::test]
async fn a_role_the_agency_does_not_hold_reads_as_none() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.answer(
    Method::GET,
    "/roles/no-such-role",
    404,
    json!({ "error": "no role no-such-role", "code": "not-found" }),
  );

  assert_eq!(agency.role("no-such-role").await.unwrap(), None);
  assert_eq!(stub.one("/roles/no-such-role").bearer().as_deref(), Some("t"));
}

#[tokio::test]
async fn a_gate_run_is_a_conversation_and_one_turn_carrying_the_whole_system_prompt() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.answer(
    Method::POST,
    "/sessions",
    201,
    json!({ "id": "s-1", "agentName": "a-work-key", "scope": "conversation" }),
  );
  stub.answer(
    Method::POST,
    "/sessions/s-1/turns",
    201,
    json!({ "id": 1, "sessionId": "s-1", "state": "ended", "delivery": "delivered", "outcome": "answered", "answer": "[]" }),
  );

  let apart = Apart {
    provider: "claude-code".into(),
    model: "a-model".into(),
    cwd: "/tmp/empty".into(),
  };
  let session = agency.start_apart("a-work-key", &apart).await.unwrap();
  let turn = GateTurn {
    session: session.id.clone(),
    prompt: "the material".into(),
    provider: "claude-code".into(),
    model: "a-model".into(),
    mapping: Line {
      model: "a-model".into(),
      effort: Some("low".into()),
      answer_tokens: None,
    },
    name: "gate:a-gate:1".into(),
    gate: "a-gate".into(),
    chat: Some(7),
    system: "the gate's instructions".into(),
    thinking: false,
  };
  let ended = agency.turn(&turn).await.unwrap();

  assert_eq!(ended.outcome, "answered");
  assert_eq!(ended.answer.as_deref(), Some("[]"));
  assert_eq!(
    stub.one("/sessions").json(),
    json!({ "agentName": "a-work-key", "scope": "conversation", "options": { "provider": "claude-code", "model": "a-model", "cwd": "/tmp/empty" } })
  );
  assert_eq!(
    stub.one("/sessions/s-1/turns").json(),
    json!({
      "prompt": "the material",
      "gate": {
        "system": "the gate's instructions", "thinking": false, "model": "a-model", "effort": "low"
      }
    })
  );
}

#[tokio::test]
async fn the_roads_walked_are_read_off_the_event_stream_with_their_numbers_and_nothing_else_is() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));
  let road = json!({
    "stage": "chat", "chatId": 7, "run": "turn:1", "provider": "claude-code", "model": "a-model", "outcome": "answered",
    "ms": 1500, "inputTokens": 10, "outputTokens": 20, "cacheReadTokens": null, "cacheWriteTokens": null, "contextRatio": 0.4
  });
  let walked = json!({ "id": 42, "kind": "road-walked", "at": 1, "data": road });
  let missed = json!({ "kind": "events.missed", "at": 1, "data": { "after": 12, "keptFrom": 30 } });
  let body = format!(
    "event: events.missed\ndata: {missed}\n\nid: 41\nevent: turn.ended\ndata: {{\"id\":41,\"data\":{{}}}}\n\nid: 42\nevent: road-walked\ndata: {walked}\n\n"
  );

  stub.canned(Method::GET, "/events", 200, "text/event-stream", body);

  let told: Vec<_> = agency.roads_walked(Some(12)).await.unwrap().collect().await;
  let told: Vec<RoadEvent> = told.into_iter().map(Result::unwrap).collect();

  assert_eq!(told.len(), 2, "{told:?}");
  assert_eq!(
    told[0],
    RoadEvent::Missed {
      after: 12,
      kept_from: Some(30)
    }
  );
  let RoadEvent::Walked { event, road } = &told[1] else { panic!("{told:?}") };
  assert_eq!(*event, 42);
  assert_eq!(road.stage, "chat");
  assert_eq!(road.chat_id, Some(7));
  assert_eq!(road.context_ratio, Some(0.4));

  let asked = stub.one("/events");
  assert_eq!(asked.query.as_deref(), Some("kinds=road-walked"));
  assert_eq!(asked.header("last-event-id").as_deref(), Some("12"));
}

#[tokio::test]
async fn the_roads_walked_with_no_number_are_opened_from_now_on() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.canned(Method::GET, "/events", 200, "text/event-stream", String::new());

  let told: Vec<_> = agency.roads_walked(None).await.unwrap().collect().await;

  assert!(told.is_empty(), "{told:?}");
  assert_eq!(stub.one("/events").header("last-event-id"), None);
}

#[tokio::test]
async fn a_road_frame_with_no_number_does_not_read() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.canned(
    Method::GET,
    "/events",
    200,
    "text/event-stream",
    "event: road-walked\ndata: {\"data\":{}}\n\n".to_owned(),
  );

  let told: Vec<_> = agency.roads_walked(None).await.unwrap().collect().await;

  assert!(matches!(told.as_slice(), [Err(PortError::Malformed { .. })]), "{told:?}");
}

// The agency `turns` stands in for, a call it gives no answer asked again at once.
fn patient(turns: &Turns) -> HttpAgency {
  let patience = Patience {
    first: Duration::ZERO,
    most: Duration::ZERO,
  };

  HttpAgency::new(Peer::new(&turns.address, Some("t".to_owned())).unwrap()).with_patience(patience)
}

fn ask() -> TranslationAsk {
  TranslationAsk {
    purpose: "worker".into(),
    language: "English".into(),
    text: "a text".into(),
    note: None,
  }
}

#[tokio::test]
async fn a_translation_run_is_asked_again_through_closed_connections_and_503_until_the_agency_answers() {
  let answered =
    json!({ "text": "the translation", "provider": "a-provider", "model": "a-model" }).to_string();
  let turns = Turns::start(vec![
    Step::Close,
    Step::Answer(503, json!({ "code": "starting", "error": "the agency is starting" }).to_string()),
    Step::Close,
    Step::Answer(200, answered),
  ])
  .await;

  let run = patient(&turns).translation_run(&ask()).await.unwrap();

  assert_eq!(run.text, "the translation");
  assert_eq!(turns.taken(), 4);
}

#[tokio::test]
async fn a_translation_run_the_agency_refuses_otherwise_is_asked_once() {
  for (status, code) in [(413, "too-large"), (500, "internal")] {
    let turns = Turns::start(vec![
      Step::Answer(status, json!({ "code": code, "error": "refused" }).to_string()),
      Step::Answer(200, json!({ "text": "never asked" }).to_string()),
    ])
    .await;

    let failed = patient(&turns).translation_run(&ask()).await.unwrap_err();

    assert_eq!(failed.refused_with(), Some(code));
    assert_eq!(turns.taken(), 1, "{code}");
  }
}
