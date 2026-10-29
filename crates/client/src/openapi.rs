//! The OpenAPI 3.1 document, generated from the contract's own types and the route table. The committed
//! `docs/openapi.json` is this document, and a test fails where the two differ (`docs/api.md`, 「The document」).

use schemars::generate::{SchemaGenerator, SchemaSettings};
use schemars::{JsonSchema, Schema};
use serde_json::{Map, Value, json};

use crate::types::*;

/// A schema made from one of the contract's types.
type MakeSchema = fn(&mut SchemaGenerator) -> Schema;

/// One answer a route gives.
type Answer = (u16, &'static str, Option<MakeSchema>);

/// A generator whose definitions are the document's component schemas.
pub fn generator() -> SchemaGenerator {
  SchemaSettings::draft2020_12()
    .for_serialize()
    .with(|settings| {
      settings.definitions_path = "/components/schemas".into();
      settings.meta_schema = None;
    })
    .into_generator()
}

fn made<T: JsonSchema>(generator: &mut SchemaGenerator) -> Schema {
  generator.subschema_for::<T>()
}

fn query_of<T: JsonSchema>(generator: &mut SchemaGenerator) -> Vec<Value> {
  query_parameters(made::<T>(generator))
}

/// The whole document.
pub fn document() -> Value {
  let mut generator = generator();
  let mut paths = Map::new();

  route(
    &mut paths,
    &mut generator,
    "get",
    "/health",
    "health",
    "Health",
    "Readiness, reason and version.",
    vec![],
    None,
    None,
    &[(200, "the service's health", Some(made::<Health>))],
    &["unauthorized", "failed", "not-ready"],
  );

  route(
    &mut paths,
    &mut generator,
    "get",
    "/gates",
    "gates",
    "Gates",
    "Every gate of the gate order, with the profile it runs under.",
    vec![],
    None,
    None,
    &[(200, "the gate order", Some(made::<Page<Gate>>))],
    &["unauthorized", "failed"],
  );

  route(
    &mut paths,
    &mut generator,
    "get",
    "/options/{gateName}",
    "gate_options",
    "Gates",
    "One gate's options as it stands for the chat agent.",
    vec![("gateName", "string")],
    None,
    None,
    &[(200, "the gate's options", Some(made::<GateOptions>))],
    &["unauthorized", "no-gate", "failed", "upstream-failed"],
  );
  route(
    &mut paths,
    &mut generator,
    "post",
    "/options/{gateName}",
    "gate_options_change",
    "Gates",
    "Change a gate's wait or switch.",
    vec![("gateName", "string")],
    None,
    Some(made::<GateOptionChange>),
    &[(200, "the options as the change left them", Some(made::<GateOptionsChanged>))],
    &[
      "unauthorized",
      "bad-request",
      "no-gate",
      "own-llm",
      "nothing-to-change",
      "timeout-out-of-range",
      "switch-not-boolean",
      "always-on",
      "failed",
      "upstream-failed",
    ],
  );

  route(
    &mut paths,
    &mut generator,
    "post",
    "/options/{gateName}/agents/{agentName}",
    "gate_options_change_for_agent",
    "Gates",
    "Change a gate's options for one agent, as the chat agent's are changed, leaving every other agent's as they stand.",
    vec![("gateName", "string"), ("agentName", "string")],
    None,
    Some(made::<GateOptionChange>),
    &[(
      200,
      "the options as the change left them for the agent",
      Some(made::<GateOptionsChanged>),
    )],
    &[
      "unauthorized",
      "bad-request",
      "no-gate",
      "own-llm",
      "nothing-to-change",
      "timeout-out-of-range",
      "switch-not-boolean",
      "always-on",
      "failed",
      "upstream-failed",
    ],
  );

  route(
    &mut paths,
    &mut generator,
    "post",
    "/options/copied",
    "options_copied",
    "Gates",
    "Copy the chat agent's rows for every gate under a companion's name.",
    vec![],
    None,
    Some(made::<OptionsCopied>),
    &[(204, "the rows were copied", None)],
    &["unauthorized", "bad-request", "failed"],
  );

  route(
    &mut paths,
    &mut generator,
    "get",
    "/judgements",
    "judgements",
    "Judgements",
    "A room's judgements, newest first, each with its roads and what its round's gates were offered.",
    vec![],
    Some(query_of::<JudgementQuery>),
    None,
    &[(200, "a page of judgements", Some(made::<Page<Judgement>>))],
    &["unauthorized", "bad-request", "failed"],
  );
  route(
    &mut paths,
    &mut generator,
    "post",
    "/judgements",
    "judgement_add",
    "Judgements",
    "Write one judgement into a room's log.",
    vec![],
    None,
    Some(made::<NewJudgement>),
    &[(201, "the judgement as it was written", Some(made::<Judgement>))],
    &["unauthorized", "bad-request", "failed"],
  );
  route(
    &mut paths,
    &mut generator,
    "post",
    "/judgements/attached",
    "judgements_attached",
    "Judgements",
    "Put a round's judgements under the message that answered it.",
    vec![],
    None,
    Some(made::<AttachJudgements>),
    &[(204, "the judgements were attached", None)],
    &["unauthorized", "bad-request", "failed"],
  );

  route(
    &mut paths,
    &mut generator,
    "post",
    "/reference/selected",
    "reference_selected",
    "Reference",
    "What a turn is handed with no model: the speakers' sheet heads, the due memories and the rows its events wake.",
    vec![],
    None,
    Some(made::<ReferenceAsk>),
    &[(200, "the pieces the turn is handed", Some(made::<ReferenceAnswer>))],
    &["unauthorized", "bad-request", "stopped", "failed", "upstream-failed"],
  );

  route(
    &mut paths,
    &mut generator,
    "get",
    "/reference/index",
    "reference_index",
    "Reference",
    "The brain's index for an agent in a room: five groups, each its unread count against the session's loads, its hint and its entries.",
    vec![],
    Some(query_of::<ReferenceIndexQuery>),
    None,
    &[(200, "the index", Some(made::<ReferenceIndex>))],
    &["unauthorized", "bad-request", "failed", "upstream-failed"],
  );
  route(
    &mut paths,
    &mut generator,
    "get",
    "/reference/pieces/{slug}",
    "reference_piece",
    "Reference",
    "One piece of the index read whole by its slug within its group, recorded among the session's loads where one is named.",
    vec![("slug", "string")],
    Some(query_of::<ReferencePieceQuery>),
    None,
    &[(200, "the piece", Some(made::<ReferencePiece>))],
    &["unauthorized", "bad-request", "not-found", "failed", "upstream-failed"],
  );
  route(
    &mut paths,
    &mut generator,
    "get",
    "/reference/search",
    "reference_search",
    "Reference",
    "The index's entries whose words match a query, with no model, the ones holding the most of its words first.",
    vec![],
    Some(query_of::<ReferenceSearchQuery>),
    None,
    &[(200, "the entries found", Some(made::<ReferenceSearch>))],
    &["unauthorized", "bad-request", "failed", "upstream-failed"],
  );

  route(
    &mut paths,
    &mut generator,
    "post",
    "/translations",
    "translations",
    "Translations",
    "Translate at most 16 originals into one language, in the order given, keeping each whole reading.",
    vec![],
    None,
    Some(made::<TranslationAsk>),
    &[(200, "one reading for each original", Some(made::<Readings>))],
    &[
      "unauthorized",
      "forbidden",
      "bad-request",
      "too-many-originals",
      "language-unknown",
      "stopped",
      "failed",
      "upstream-failed",
      "translator-busy",
    ],
  );
  route(
    &mut paths,
    &mut generator,
    "get",
    "/translations/kept",
    "translations_kept",
    "Translations",
    "The translations kept for the originals named, in one language, without asking the translator.",
    vec![],
    Some(query_of::<KeptQuery>),
    None,
    &[(200, "the translations kept", Some(made::<Page<KeptTranslation>>))],
    &["unauthorized", "bad-request", "language-unknown", "failed"],
  );
  route(
    &mut paths,
    &mut generator,
    "put",
    "/translations/kept",
    "translation_keep",
    "Translations",
    "Keep a reading of one original in one language, in place of any kept before.",
    vec![],
    None,
    Some(made::<KeepTranslation>),
    &[(200, "the translation kept", Some(made::<KeptTranslation>))],
    &["unauthorized", "bad-request", "language-unknown", "failed"],
  );

  route(
    &mut paths,
    &mut generator,
    "post",
    "/stages/{gateName}/runs",
    "stage_run",
    "Runs",
    "One run of one gate on its road, its instructions the gate's own where the caller names none.",
    vec![("gateName", "string")],
    None,
    Some(made::<StageRunAsk>),
    &[(200, "what the run answered", Some(made::<StageRun>))],
    &["unauthorized", "bad-request", "no-gate", "stopped", "failed", "upstream-failed"],
  );

  route(
    &mut paths,
    &mut generator,
    "get",
    "/trials",
    "trials",
    "Trials",
    "A gate's trials, oldest first.",
    vec![],
    Some(query_of::<TrialQuery>),
    None,
    &[(200, "a page of trials", Some(made::<Page<Trial>>))],
    &["unauthorized", "bad-request", "no-gate", "failed"],
  );
  route(
    &mut paths,
    &mut generator,
    "post",
    "/trials",
    "trial_add",
    "Trials",
    "Put one prompt to one gate as a turn would, keep the trial and answer it.",
    vec![],
    None,
    Some(made::<NewTrial>),
    &[(201, "the trial as it was kept", Some(made::<Trial>))],
    &[
      "unauthorized",
      "bad-request",
      "no-gate",
      "too-large",
      "stopped",
      "failed",
      "upstream-failed",
    ],
  );

  route(
    &mut paths,
    &mut generator,
    "post",
    "/documents/translations",
    "document_translation_add",
    "Documents",
    "Queue a document's translation part by part.",
    vec![],
    None,
    Some(made::<DocumentTranslationOrder>),
    &[(202, "the parts queued", Some(made::<Taken>))],
    &["unauthorized", "bad-request", "document-unknown", "language-unknown", "failed"],
  );
  route(
    &mut paths,
    &mut generator,
    "get",
    "/documents/translations/state",
    "document_translation_state",
    "Documents",
    "Where a document's translation into one language stands.",
    vec![],
    Some(query_of::<DocumentStateQuery>),
    None,
    &[(200, "its state", Some(made::<DocumentTranslationState>))],
    &["unauthorized", "bad-request", "document-unknown", "language-unknown", "failed"],
  );
  route(
    &mut paths,
    &mut generator,
    "get",
    "/documents/translations/parts",
    "document_translation_parts",
    "Documents",
    "A document's translated parts, in part order.",
    vec![],
    Some(query_of::<DocumentPartsQuery>),
    None,
    &[(200, "a page of its parts", Some(made::<Page<DocumentPart>>))],
    &["unauthorized", "bad-request", "document-unknown", "language-unknown", "failed"],
  );

  route(
    &mut paths,
    &mut generator,
    "get",
    "/events",
    "events",
    "Events",
    "The gate's one stream of events, as server-sent events.",
    vec![],
    None,
    None,
    &[(200, "the event stream", None)],
    &["unauthorized", "failed"],
  );

  let error = made::<ErrorBody>(&mut generator).to_value();
  let definitions = generator.take_definitions(true);
  let mut document = Map::new();
  document.insert("openapi".into(), json!("3.1.0"));
  document.insert(
    "info".into(),
    json!({
      "title": "bmo-gate",
      "version": env!("CARGO_PKG_VERSION"),
      "description": "The gate stage of a turn: summarising a fresh session's start, handing a turn what \
        attaches without a pick and the brain's index, checking an answer on its way out, and translating. \
        Every answer is data in the common wire format.",
    }),
  );
  document.insert("servers".into(), json!([{ "url": "/", "description": "the gate service" }]));
  document.insert("security".into(), json!([{ "bearer": [] }]));
  document.insert("paths".into(), Value::Object(paths));
  document.insert(
    "components".into(),
    json!({
      "securitySchemes": { "bearer": { "type": "http", "scheme": "bearer" } },
      "responses": {
        "Error": {
          "description": "a refusal or failure, in the common error shape",
          "content": { "application/json": { "schema": error } },
        }
      },
      "schemas": definitions,
    }),
  );
  document.insert(
    "tags".into(),
    json!([
      "Health",
      "Gates",
      "Judgements",
      "Reference",
      "Translations",
      "Runs",
      "Trials",
      "Documents",
      "Events",
    ]),
  );

  Value::Object(document)
}

#[allow(clippy::too_many_arguments)]
fn route(
  paths: &mut Map<String, Value>,
  generator: &mut SchemaGenerator,
  method: &str,
  path: &str,
  operation_id: &str,
  tag: &str,
  summary: &str,
  path_parameters: Vec<(&str, &str)>,
  query: Option<fn(&mut SchemaGenerator) -> Vec<Value>>,
  body: Option<MakeSchema>,
  answers: &[Answer],
  codes: &[&str],
) {
  let mut parameters: Vec<Value> = path_parameters
    .into_iter()
    .map(|(name, kind)| json!({ "name": name, "in": "path", "required": true, "schema": { "type": kind } }))
    .collect();
  if let Some(query) = query {
    parameters.extend(query(generator));
  }

  let mut responses = Map::new();
  for (status, description, schema) in answers {
    let mut response = Map::new();
    response.insert("description".into(), json!(description));
    if let Some(make) = schema {
      response.insert(
        "content".into(),
        json!({ "application/json": { "schema": make(generator).to_value() } }),
      );
    }
    responses.insert(status.to_string(), Value::Object(response));
  }
  responses.insert("default".into(), json!({ "$ref": "#/components/responses/Error" }));

  let mut operation = Map::new();
  operation.insert("operationId".into(), json!(operation_id));
  operation.insert("tags".into(), json!([tag]));
  operation.insert("summary".into(), json!(summary));
  if !parameters.is_empty() {
    operation.insert("parameters".into(), Value::Array(parameters));
  }
  if let Some(make) = body {
    operation.insert(
      "requestBody".into(),
      json!({ "required": true, "content": { "application/json": { "schema": make(generator).to_value() } } }),
    );
  }
  operation
    .insert("x-codes".into(), json!(codes.iter().map(|code| (*code).to_owned()).collect::<Vec<_>>()));
  operation.insert("responses".into(), Value::Object(responses));

  paths
    .entry(path.to_owned())
    .or_insert_with(|| Value::Object(Map::new()))
    .as_object_mut()
    .expect("a path's entry is an object")
    .insert(method.to_owned(), Value::Object(operation));
}

/// A query object's properties as query parameters, a nullable type written as the type alone.
fn query_parameters(query: Schema) -> Vec<Value> {
  let query = query.to_value();
  let required: Vec<&str> = query
    .get("required")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .collect();
  let Some(properties) = query.get("properties").and_then(Value::as_object) else {
    return Vec::new();
  };

  properties
    .iter()
    .map(|(name, schema)| {
      let mut schema = schema.as_object().cloned().unwrap_or_default();
      let description = schema.remove("description");
      if let Some(Value::Array(types)) = schema.get("type") {
        let types: Vec<Value> =
          types.iter().filter(|kind| kind.as_str() != Some("null")).cloned().collect();
        let single = if types.len() == 1 { types[0].clone() } else { Value::Array(types) };
        schema.insert("type".into(), single);
      }
      let mut parameter = Map::new();
      parameter.insert("name".into(), json!(name));
      parameter.insert("in".into(), json!("query"));
      parameter.insert("required".into(), json!(required.contains(&name.as_str())));
      if let Some(description) = description {
        parameter.insert("description".into(), description);
      }
      parameter.insert("schema".into(), Value::Object(schema));
      Value::Object(parameter)
    })
    .collect()
}
