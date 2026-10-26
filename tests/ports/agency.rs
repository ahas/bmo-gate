//! The agency port: the agents, the rulebooks, the providers, a work key's route and mapping, the stand-in, a
//! thrown-away session and its one turn, a session ended, the roads walked and the hook registered.

use axum::http::Method;
use futures_util::StreamExt;
use gate_ports::agency::{Agency, Apart, GateTurn, HttpAgency, Line};
use serde_json::json;

use crate::peer;
use crate::stub::Stub;

#[tokio::test]
async fn the_reads_answer_the_agents_the_rulebooks_the_providers_and_the_work_key() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "control-token"));

  stub.answer(
    Method::GET,
    "/agents",
    200,
    json!({ "items": [{ "name": "chat-agent", "label": "The agent", "awake": true, "brainFolder": "", "recollectorRegistration": null, "role": "chat" }] }),
  );
  stub.answer(
    Method::GET,
    "/agents/chat-agent",
    200,
    json!({ "name": "chat-agent", "standInAvailable": false }),
  );
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
    "/work-keys/output-format",
    200,
    json!({ "key": "output-format", "provider": "claude-code", "model": "a-model", "effort": "low", "answerTokens": 2048, "capMs": 0, "runMode": "run" }),
  );

  let agents = agency.agents().await.unwrap();
  let rulebooks = agency.rulebooks(&["plain-writing", "recollection"]).await.unwrap();
  let providers = agency.providers().await.unwrap();
  let route = agency.work_key("output-format").await.unwrap().unwrap();
  let stand_in = agency.stand_in("chat-agent").await.unwrap();

  assert_eq!(agents[0].brain_folder.as_deref(), Some(""));
  assert_eq!(agents[0].rest["role"], json!("chat"));
  assert_eq!(rulebooks[0].text, "Write plainly.");
  assert_eq!(providers[0].lines, vec!["gate"]);
  assert_eq!(route.provider.as_deref(), Some("claude-code"));
  assert_eq!(route.model.as_deref(), Some("a-model"));
  assert_eq!(route.answer_tokens, Some(2048));
  assert!(!stand_in);
  assert_eq!(stub.one("/rulebooks").query.as_deref(), Some("names=plain-writing%2Crecollection"));
  assert_eq!(stub.one("/agents").bearer().as_deref(), Some("control-token"));
}

#[tokio::test]
async fn a_mapping_is_resolved_at_a_tier_and_a_key_no_provider_serves_resolves_to_none() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.answer(
    Method::GET,
    "/work-keys/output-format",
    200,
    json!({ "key": "output-format", "provider": "claude-code", "model": "a-model", "effort": "low", "answerTokens": 2048 }),
  );

  let mapping = agency.resolve("output-format", None, "Light").await.unwrap().unwrap();

  assert_eq!(mapping.provider.as_deref(), Some("claude-code"));
  assert_eq!(mapping.model.as_deref(), Some("a-model"));
  assert_eq!(mapping.answer_tokens, Some(2048));
  assert_eq!(stub.one("/work-keys/output-format").query.as_deref(), Some("tier=Light"));

  let named = Stub::start().await;
  named.answer(
    Method::GET,
    "/work-keys/output-format",
    200,
    json!({ "key": "output-format", "provider": "codex", "model": "a-codex-model", "effort": "low", "answerTokens": null }),
  );

  assert_eq!(
    HttpAgency::new(peer(&named, "t"))
      .resolve("output-format", Some("codex"), "Light")
      .await
      .unwrap()
      .unwrap()
      .provider
      .as_deref(),
    Some("codex")
  );
  assert_eq!(
    named.one("/work-keys/output-format").query.as_deref(),
    Some("tier=Light&provider=codex")
  );

  let none = Stub::start().await;
  none.answer(
    Method::GET,
    "/work-keys/output-format",
    404,
    json!({ "error": "no route serves output-format", "code": "not-found" }),
  );

  assert_eq!(
    HttpAgency::new(peer(&none, "t"))
      .resolve("output-format", Some("codex"), "Light")
      .await
      .unwrap(),
    None
  );
}

#[tokio::test]
async fn a_gate_run_is_a_conversation_and_one_turn_carrying_the_whole_system_prompt() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.answer(
    Method::POST,
    "/sessions",
    201,
    json!({ "id": "s-1", "agentName": "output-format", "scope": "conversation" }),
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
  let session = agency.start_apart("output-format", &apart).await.unwrap();
  let turn = GateTurn {
    session: session.id.clone(),
    prompt: "the material".into(),
    provider: "claude-code".into(),
    model: "a-model".into(),
    mapping: Line {
      model: "a-model".into(),
      effort: Some("low".into()),
      tier: Some("Light".into()),
      answer_tokens: None,
    },
    name: "gate:output-format:1".into(),
    work_key: "output-format".into(),
    chat: Some(7),
    system: "the gate's instructions".into(),
    thinking: false,
  };
  let ended = agency.turn(&turn).await.unwrap();

  assert_eq!(ended.outcome, "answered");
  assert_eq!(ended.answer.as_deref(), Some("[]"));
  assert_eq!(
    stub.one("/sessions").json(),
    json!({ "agentName": "output-format", "scope": "conversation", "options": { "provider": "claude-code", "model": "a-model", "cwd": "/tmp/empty" } })
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
async fn a_session_is_ended() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.canned(Method::DELETE, "/sessions/s-3", 204, "application/json", String::new());

  agency.stop("s-3", "the caller left").await.unwrap();

  assert_eq!(stub.one("/sessions/s-3").method, Method::DELETE);
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
