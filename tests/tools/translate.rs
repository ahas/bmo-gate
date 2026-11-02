//! The translator's tool answering calls against a stand-in gate: the readings in order, a refusal, the address and
//! token read from the record or the call's environment, and the requests it does not answer.

use axum::http::Method;
use gate_translate_tool::{ADDRESS, ENTRY, TOKEN, TOKEN_FILE, answer};
use serde_json::{Value, json};

use crate::support::stub::Stub;

fn call(arguments: Value, variables: Value) -> String {
  json!({
    "protocol": 1,
    "kind": "call",
    "entry": ENTRY,
    "arguments": arguments,
    "session": { "holderName": "a-holder", "namespaces": ["gate"], "capabilities": ["gate.translate"], "grants": [], "variables": variables },
  })
  .to_string()
}

fn nothing(_: &str) -> Option<String> {
  None
}

fn text(result: &Value) -> &str {
  result["content"][0]["text"].as_str().expect("the result carries a text piece")
}

#[tokio::test]
async fn the_readings_come_back_in_order() {
  let gate = Stub::start().await;
  let readings = json!({ "readings": [
    { "text": "The first reading.", "whole": true },
    { "text": "The second reading.", "whole": false },
  ] });
  gate.answer(Method::POST, "/translations", 200, readings.clone());

  let asked = call(
    json!({ "language": "en", "texts": ["first", "second"] }),
    json!({ ADDRESS: gate.address, TOKEN: "a-token" }),
  );
  let result = answer(&asked, nothing).await.unwrap();

  assert_eq!(result["isError"], false);
  assert_eq!(result["structuredContent"], readings);
  assert_eq!(serde_json::from_str::<Value>(text(&result)).unwrap(), readings);

  let seen = gate.one("/translations");
  assert_eq!(seen.method, Method::POST);
  assert_eq!(seen.bearer().as_deref(), Some("a-token"));
  assert_eq!(seen.json(), json!({ "language": "en", "originals": ["first", "second"] }));
}

#[tokio::test]
async fn a_refusal_names_the_status_the_code_and_the_gates_sentence() {
  let gate = Stub::start().await;
  gate.answer(
    Method::POST,
    "/translations",
    422,
    json!({ "code": "language-unknown", "error": "no reader takes xx" }),
  );

  let asked = call(
    json!({ "language": "xx", "texts": ["one"] }),
    json!({ ADDRESS: gate.address, TOKEN: "a-token" }),
  );
  let result = answer(&asked, nothing).await.unwrap();

  assert_eq!(result["isError"], true);
  assert!(result.get("structuredContent").is_none());
  assert_eq!(
    text(&result),
    "The gate refused the translation with 422 language-unknown: no reader takes xx"
  );
}

#[tokio::test]
async fn the_address_and_a_token_file_are_read_from_the_environment_where_the_record_names_none() {
  let gate = Stub::start().await;
  gate.answer(
    Method::POST,
    "/translations",
    200,
    json!({ "readings": [{ "text": "one", "whole": true }] }),
  );
  let folder = tempfile::tempdir().unwrap();
  let file = folder.path().join("gate.token");
  std::fs::write(&file, "a-filed-token\n").unwrap();

  let address = gate.address.clone();
  let file = file.to_string_lossy().into_owned();
  let environment = move |name: &str| match name {
    ADDRESS => Some(address.clone()),
    TOKEN_FILE => Some(file.clone()),
    _ => None,
  };
  let result = answer(&call(json!({ "language": "en", "texts": ["one"] }), json!({})), environment)
    .await
    .unwrap();

  assert_eq!(result["isError"], false);
  assert_eq!(gate.one("/translations").bearer().as_deref(), Some("a-filed-token"));
}

#[tokio::test]
async fn the_records_variables_stand_over_the_environment() {
  let gate = Stub::start().await;
  gate.answer(Method::POST, "/translations", 200, json!({ "readings": [] }));

  let environment = |name: &str| (name == TOKEN).then(|| "the-environments-token".to_owned());
  let asked = call(
    json!({ "language": "en", "texts": [] }),
    json!({ ADDRESS: gate.address, TOKEN: "the-records-token" }),
  );
  answer(&asked, environment).await.unwrap();

  assert_eq!(gate.one("/translations").bearer().as_deref(), Some("the-records-token"));
}

#[tokio::test]
async fn a_record_naming_no_gate_is_answered_its_reason() {
  let no_address = answer(
    &call(json!({ "language": "en", "texts": ["one"] }), json!({ TOKEN: "a-token" })),
    nothing,
  )
  .await
  .unwrap();
  assert_eq!(no_address["isError"], true);
  assert!(text(&no_address).starts_with("ERROR: "));
  assert!(text(&no_address).contains(ADDRESS));

  let no_token = answer(
    &call(json!({ "language": "en", "texts": ["one"] }), json!({ ADDRESS: "http://127.0.0.1:9" })),
    nothing,
  )
  .await
  .unwrap();
  assert_eq!(no_token["isError"], true);
  assert!(text(&no_token).contains(TOKEN) && text(&no_token).contains(TOKEN_FILE));
}

#[tokio::test]
async fn a_gate_that_cannot_be_reached_is_answered_its_reason() {
  let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
  let address = format!("http://{}", listener.local_addr().unwrap());
  drop(listener);

  let asked = call(
    json!({ "language": "en", "texts": ["one"] }),
    json!({ ADDRESS: address, TOKEN: "a-token" }),
  );
  let result = answer(&asked, nothing).await.unwrap();

  assert_eq!(result["isError"], true);
  assert!(text(&result).starts_with("ERROR: the gate could not be reached"));
}

#[tokio::test]
async fn arguments_outside_the_schema_are_refused() {
  let asked = call(json!({ "language": "en", "text": "one" }), json!({}));
  let result = answer(&asked, nothing).await.unwrap();

  assert_eq!(result["isError"], true);
  assert!(text(&result).starts_with("The arguments do not read"));
}

#[tokio::test]
async fn a_request_the_tool_does_not_answer_ends_it_unclean() {
  let listing = json!({ "protocol": 1, "kind": "resources_list", "session": {} }).to_string();
  assert!(answer(&listing, nothing).await.is_err());

  let other = json!({ "protocol": 1, "kind": "call", "entry": "gate/other", "arguments": {} }).to_string();
  assert!(answer(&other, nothing).await.unwrap_err().contains("gate/other"));

  let later = json!({ "protocol": 2, "kind": "call", "entry": ENTRY, "arguments": {} }).to_string();
  assert!(answer(&later, nothing).await.is_err());

  assert!(answer("not json", nothing).await.is_err());
}
