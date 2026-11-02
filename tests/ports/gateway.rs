//! The model gateway: one chat completion with the instructions first, no wait named to the gateway, the key read
//! from its file, and the completion's text read back.

use axum::http::Method;
use gate_ports::PortError;
use gate_ports::gateway::{Ask, Gateway, HttpGateway};
use serde_json::json;

use crate::peer;
use crate::stub::Stub;

fn ask() -> Ask {
  Ask {
    model: "a-registration".into(),
    system: "the gate's instructions".into(),
    input: "the material".into(),
    max_tokens: 2048,
    thinking: false,
    sampling: Some(r#"{"temperature":0.2}"#.into()),
  }
}

/// The gateway's key in a folder of the test's own, named by `test`, so tests running at once never share one.
fn key_file(test: &str) -> std::path::PathBuf {
  let dir = std::env::temp_dir().join(format!("gate-ports-gateway-{}-{test}", std::process::id()));

  std::fs::create_dir_all(&dir).unwrap();
  let file = dir.join("gateway.key");
  std::fs::write(&file, "the-key\n").unwrap();
  file
}

#[tokio::test]
async fn a_completion_names_its_registration_and_its_messages_and_no_wait() {
  let stub = Stub::start().await;
  let key = key_file("completion");
  let gateway = HttpGateway::new(peer(&stub, "unused"), key.clone());

  stub.answer(
    Method::POST,
    "/v1/chat/completions",
    200,
    json!({ "choices": [{ "message": { "role": "assistant", "content": "FOLD" } }], "usage": { "prompt_tokens": 12 } }),
  );

  let answered = gateway.complete(&ask()).await.unwrap();
  let seen = stub.one("/v1/chat/completions");

  assert_eq!(answered.text.as_deref(), Some("FOLD"));
  assert_eq!(answered.usage, Some(json!({ "prompt_tokens": 12 })));
  assert_eq!(
    seen.json(),
    json!({
      "model": "a-registration",
      "messages": [{ "role": "system", "content": "the gate's instructions" }, { "role": "user", "content": "the material" }],
      "max_tokens": 2048,
      "chat_template_kwargs": { "enable_thinking": false }
    })
  );
  assert_eq!(seen.bearer().as_deref(), Some("the-key"));
  assert_eq!(seen.header("x-litellm-timeout"), None);
  assert_eq!(seen.header("x-litellm-stream-timeout"), None);
  assert_eq!(seen.header("x-bmo-sampling").as_deref(), Some(r#"{"temperature":0.2}"#));

  std::fs::remove_dir_all(key.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn a_size_refusal_comes_back_with_the_gateways_status_and_words() {
  let stub = Stub::start().await;
  let key = key_file("refusal");
  let gateway = HttpGateway::new(peer(&stub, "unused"), key.clone());

  stub.answer(
    Method::POST,
    "/v1/chat/completions",
    400,
    json!({ "error": { "message": "past the context window" } }),
  );

  let refused = gateway.complete(&ask()).await.unwrap_err();

  assert!(
    matches!(&refused, PortError::Refused { status: 400, error, .. } if error.contains("past the context window")),
    "{refused:?}"
  );

  std::fs::remove_dir_all(key.parent().unwrap()).unwrap();
}
