//! The contract: the committed OpenAPI document is the one the contract's types generate.

use bmo_gate_client::openapi;

#[test]
fn the_committed_document_is_the_one_the_types_generate() {
  let generated = serde_json::to_string_pretty(&openapi::document()).unwrap() + "\n";
  let committed =
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/docs/openapi.json")).unwrap();

  assert_eq!(committed, generated, "docs/openapi.json is stale; run gate-openapi");
}
