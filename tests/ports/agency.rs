//! The agency port: the agents, the rulebooks, the providers, a work key's route and mapping, the stand-in, a
//! thrown-away session and its one turn, a run stopped, the roads walked and the hook registered.

use axum::http::Method;
use futures_util::StreamExt;
use gate_ports::agency::{Agency, Apart, GateTurn, HttpAgency, Line};
use serde_json::json;

use crate::peer;
use crate::stub::Stub;

#[tokio::test]
async fn the_reads_answer_the_agents_the_rulebooks_the_providers_and_the_routes() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "control-token"));

  stub.answer(
    Method::GET,
    "/agents",
    200,
    json!({ "agents": [{ "name": "chat-agent", "label": "The agent", "awake": true, "brainFolder": "", "recollectorRegistration": null, "role": "chat" }], "roles": [] }),
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
    json!({ "providers": [{ "name": "claude-code", "enabled": true, "registered": false, "coworker": true, "lines": ["gate"] }] }),
  );
  stub.answer(
    Method::GET,
    "/fallback",
    200,
    json!({ "profiles": [{ "key": "room-rules", "routeMode": "laya", "account": null, "setAt": 12, "label": "x" }], "order": [] }),
  );
  stub.answer(Method::GET, "/stand-in", 200, json!({ "answers": false }));

  let agents = agency.agents().await.unwrap();
  let rulebooks = agency.rulebooks(&["plain-writing", "recollection"]).await.unwrap();
  let providers = agency.providers().await.unwrap();
  let routes = agency.routes().await.unwrap();
  let stand_in = agency.stand_in("chat-agent").await.unwrap();

  assert_eq!(agents[0].brain_folder.as_deref(), Some(""));
  assert_eq!(agents[0].rest["role"], json!("chat"));
  assert_eq!(rulebooks[0].text, "Write plainly.");
  assert_eq!(providers[0].lines, vec!["gate"]);
  assert_eq!(routes[0].route_mode, "laya");
  assert!(!stand_in);
  assert_eq!(stub.one("/rulebooks").query.as_deref(), Some("names=plain-writing%2Crecollection"));
  assert_eq!(stub.one("/stand-in").query.as_deref(), Some("agent=chat-agent"));
  assert_eq!(stub.one("/agents").bearer().as_deref(), Some("control-token"));
}

#[tokio::test]
async fn a_mapping_is_resolved_and_a_key_no_provider_serves_resolves_to_none() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.answer(
    Method::POST,
    "/routes/resolve",
    200,
    json!({ "provider": "claude-code", "tier": "Light", "model": "a-model", "effort": "low", "answerTokens": 2048 }),
  );

  let mapping = agency.resolve("room-rules", None, "Light").await.unwrap().unwrap();

  assert_eq!(mapping.model.as_deref(), Some("a-model"));
  assert_eq!(mapping.answer_tokens, Some(2048));
  assert_eq!(stub.one("/routes/resolve").json(), json!({ "workKey": "room-rules", "tier": "Light" }));

  let none = Stub::start().await;
  none.answer(
    Method::POST,
    "/routes/resolve",
    404,
    json!({ "error": "no provider serves it", "code": "nothing-held" }),
  );

  assert_eq!(
    HttpAgency::new(peer(&none, "t"))
      .resolve("room-rules", Some("codex"), "Light")
      .await
      .unwrap(),
    None
  );
}

#[tokio::test]
async fn a_gate_run_is_a_session_apart_and_one_fresh_turn_carrying_the_whole_system_prompt() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.answer(
    Method::POST,
    "/session/start",
    200,
    json!({ "id": "s-1", "agent": "chat-agent", "scope": { "kind": "apart" } }),
  );
  stub.answer(
    Method::POST,
    "/session/turn",
    200,
    json!({
      "delivery": "taken", "run": "gate:room-rules:1", "outcome": "answered", "answer": "[]", "reason": null,
      "engineError": null, "went_out": { "provider": "claude-code", "model": "a-model", "effort": "low", "tier": "Light" },
      "reply": { "mode": "claude-code" }, "failure": null
    }),
  );

  let apart = Apart {
    provider: "claude-code".into(),
    model: "a-model".into(),
    cwd: "/tmp/empty".into(),
  };
  let session = agency.start_apart("chat-agent", &apart).await.unwrap();
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
    name: "gate:room-rules:1".into(),
    work_key: "room-rules".into(),
    chat: Some(7),
    system: "the gate's instructions".into(),
    thinking: false,
  };
  let ended = agency.turn(&turn).await.unwrap();

  assert_eq!(ended.outcome, "answered");
  assert_eq!(ended.answer.as_deref(), Some("[]"));
  assert_eq!(ended.went_out.unwrap().model.as_deref(), Some("a-model"));
  assert_eq!(
    stub.one("/session/start").json(),
    json!({ "agent": "chat-agent", "scope": { "kind": "apart", "provider": "claude-code", "model": "a-model", "cwd": "/tmp/empty", "todo": null, "role": null } })
  );
  assert_eq!(
    stub.one("/session/turn").json(),
    json!({
      "session": "s-1", "prompt": "the material", "provider": "claude-code", "model": "a-model",
      "mapping": { "model": "a-model", "effort": "low", "tier": "Light" }, "name": "gate:room-rules:1",
      "work_key": "room-rules", "chat": 7, "system": "the gate's instructions", "thinking": false, "resume": { "kind": "fresh" }
    })
  );
}

#[tokio::test]
async fn a_run_is_stopped_and_the_hook_registered() {
  let stub = Stub::start().await;
  let agency = HttpAgency::new(peer(&stub, "t"));

  stub.answer(Method::POST, "/runs/stop", 200, json!({ "stopped": 1 }));
  stub.canned(Method::POST, "/hooks", 204, "application/json", String::new());

  agency.stop("gate:sanitizer:3", "the caller left").await.unwrap();
  agency
    .register_hook("session-summariser", "http://gate.example/hooks/session-summariser", Some("gate-token"))
    .await
    .unwrap();

  assert_eq!(
    stub.one("/runs/stop").json(),
    json!({ "run": "gate:sanitizer:3", "reason": "the caller left" })
  );
  assert_eq!(
    stub.one("/hooks").json(),
    json!({ "point": "session-summariser", "url": "http://gate.example/hooks/session-summariser", "token": "gate-token" })
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
