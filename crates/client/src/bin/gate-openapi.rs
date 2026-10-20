//! Prints the OpenAPI document the contract's types generate, for `docs/openapi.json`.

fn main() {
  let document = bmo_gate_client::openapi::document();
  println!("{}", serde_json::to_string_pretty(&document).expect("the document writes as JSON"));
}
