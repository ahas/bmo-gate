//! The brain's index tool answering calls against a stand-in gate: the index for the turn's room and session, a
//! piece by its slug and group, a search with its limit, each for the agent the record names, and a call whose record
//! names no agent, or no room where the call names none, refused.

use axum::http::Method;
use gate_reference_tool::{ADDRESS, AGENT, INDEX, PIECE, ROOM, SEARCH, SESSION, TOKEN, answer};
use serde_json::{Value, json};

use crate::support::stub::Stub;

fn call(entry: &str, arguments: Value, variables: Value) -> String {
  json!({
    "protocol": 1,
    "kind": "call",
    "entry": entry,
    "arguments": arguments,
    "session": { "holderName": "a-holder", "namespaces": ["gate"], "capabilities": ["gate.reference"], "grants": [], "variables": variables },
  })
  .to_string()
}

fn nothing(_: &str) -> Option<String> {
  None
}

#[tokio::test]
async fn the_index_a_piece_and_a_search_go_to_the_gate_for_the_turns_room_and_session() {
  let gate = Stub::start().await;
  let index = json!({ "groups": [{ "group": "knowledge", "unread": 1, "hint": null, "entries": [
    { "slug": "release", "holds": "How a release goes out", "readWhen": "needed when releasing", "path": "knowledge/release.md" }
  ] }] });
  let piece = json!({ "slug": "release", "group": "knowledge", "path": "knowledge/release.md", "text": "The whole piece." });
  let found = json!({ "entries": [{ "slug": "release", "group": "knowledge", "holds": "How a release goes out", "readWhen": null }] });

  gate.answer(Method::GET, "/reference/index", 200, index.clone());
  gate.answer(Method::GET, "/reference/pieces/release", 200, piece.clone());
  gate.answer(Method::GET, "/reference/search", 200, found.clone());

  let variables = json!({ ADDRESS: gate.address, TOKEN: "a-token", AGENT: "agent-a", ROOM: "-500", SESSION: "session-a" });
  let result = answer(&call(INDEX, json!({}), variables.clone()), nothing).await.unwrap();

  assert_eq!(result["isError"], false);
  assert_eq!(result["structuredContent"], index);

  let result = answer(
    &call(PIECE, json!({ "slug": "release", "group": "knowledge" }), variables.clone()),
    nothing,
  )
  .await
  .unwrap();

  assert_eq!(result["structuredContent"], piece);

  let result = answer(&call(SEARCH, json!({ "query": "release", "limit": 3 }), variables), nothing)
    .await
    .unwrap();

  assert_eq!(result["structuredContent"], found);

  let asked = gate.one("/reference/index");
  let query = asked.query.clone().unwrap_or_default();

  assert_eq!(asked.bearer().as_deref(), Some("a-token"));
  assert!(
    query.contains("room=-500") && query.contains("session=session-a") && query.contains("agent=agent-a"),
    "{query}"
  );
  assert!(
    gate
      .one("/reference/pieces/release")
      .query
      .unwrap_or_default()
      .contains("group=knowledge")
  );
  assert!(gate.one("/reference/search").query.unwrap_or_default().contains("limit=3"));
}

#[tokio::test]
async fn a_call_whose_record_names_no_agent_or_no_room_is_refused() {
  let gate = Stub::start().await;

  for variables in [
    json!({ ADDRESS: gate.address, TOKEN: "a-token", AGENT: "agent-a" }),
    json!({ ADDRESS: gate.address, TOKEN: "a-token", ROOM: "-500" }),
    json!({ ADDRESS: gate.address, TOKEN: "a-token", AGENT: " ", ROOM: "-500" }),
  ] {
    for (entry, arguments) in [
      (INDEX, json!({})),
      (PIECE, json!({ "slug": "release", "group": "knowledge" })),
      (SEARCH, json!({ "query": "release" })),
    ] {
      let result = answer(&call(entry, arguments, variables.clone()), nothing).await.unwrap();

      assert_eq!(result["isError"], true, "{entry} {variables}");
    }
  }

  assert!(gate.seen().is_empty(), "nothing went to the gate");
  assert!(answer(&call("gate/other", json!({}), json!({})), nothing).await.is_err());
}
