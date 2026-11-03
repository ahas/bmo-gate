//! The agency port: the rulebooks, the providers, a role's provider order, a thrown-away session and its one
//! turn, and the roads walked.

use axum::http::Method;
use futures_util::StreamExt;
use gate_ports::agency::{Agency, Apart, GateTurn, HttpAgency, Line};
use serde_json::json;

use super::peer;
use crate::support::stub::Stub;

#[tokio::test]
async fn the_reads_answer_the_rulebooks_the_providers_and_a_role() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "control-token"));

  stub.answer(
    Method::GET,
    "/rulebooks",
    200,
    json!({ "rulebooks": [{ "name": "plain-writing", "text": "Write plainly." }] }),
  );
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

  let rulebooks = agency.rulebooks(&["plain-writing", "recollection"]).await.unwrap();
  let providers = agency.providers().await.unwrap();
  let role = agency.role("a-gate-role").await.unwrap().unwrap();

  assert_eq!(rulebooks[0].text, "Write plainly.");
  assert_eq!(providers[0].lines, vec!["gate"]);
  assert_eq!(role.provider.as_deref(), Some("claude-code"));
  assert_eq!(role.order[0].model, "a-model");
  assert_eq!(role.order[0].effort.as_deref(), Some("low"));
  assert_eq!(role.order[1].thinking.as_deref(), Some("on"));
  assert_eq!(role.order[1].answer_tokens, Some(2048));
  assert_eq!(stub.one("/rulebooks").query.as_deref(), Some("names=plain-writing%2Crecollection"));
  assert_eq!(stub.one("/rulebooks").bearer().as_deref(), Some("control-token"));
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
async fn the_roads_walked_are_read_off_the_event_stream_and_nothing_else_is() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));
  let road = json!({
    "stage": "chat", "chatId": 7, "run": "turn:1", "provider": "claude-code", "model": "a-model", "outcome": "answered",
    "ms": 1500, "inputTokens": 10, "outputTokens": 20, "cacheReadTokens": null, "cacheWriteTokens": null, "contextRatio": 0.4
  });
  let body =
    format!("event: turn-started\ndata: {{\"session\":\"s\"}}\n\nevent: road-walked\ndata: {road}\n\n");

  stub.canned(Method::GET, "/events", 200, "text/event-stream", body);

  let roads: Vec<_> = agency.roads_walked().await.unwrap().collect().await;

  assert_eq!(roads.len(), 1, "{roads:?}");
  let walked = roads.into_iter().next().unwrap().unwrap();
  assert_eq!(walked.stage, "chat");
  assert_eq!(walked.chat_id, Some(7));
  assert_eq!(walked.context_ratio, Some(0.4));
  assert_eq!(stub.one("/events").query.as_deref(), Some("kinds=road-walked"));
}
