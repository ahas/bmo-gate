//! For bmo-brain (`docs/boundary-api.md`, 「For bmo-brain」), in the brain's conventions: a document's sanitising,
//! a refusal answered as an answer, and a person-book sheet's judgement.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use gate_runs::GateError;
use gate_stages::sanitizer::sanitise;
use gate_stages::sheets::{self, SheetAsk};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::App;
use crate::answer::{Answered, BrainBody, Refused};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
  pub path: String,
  pub text: String,
}

pub async fn document(
  State(app): State<Arc<App>>,
  BrainBody(asked): BrainBody<Document>,
) -> Answered<Json<Value>> {
  let label = format!("a document the brain is about to keep, {}", asked.path);

  match sanitise(&app.stages, &asked.text, &label, None, None).await {
    Ok(safe) => Ok(Json(json!({ "answered": true, "text": safe.text }))),
    Err(GateError::Stopped(why)) => Ok(Json(json!({
      "answered": false,
      "refusal": { "code": "stopped", "message": format!("the sanitiser's run was stopped: {why}") }
    }))),
    Err(GateError::Fault(why)) => Err(Refused::failed(why).kebab()),
  }
}

#[derive(Serialize)]
pub struct Sheet {
  pub sheet: Option<String>,
}

pub async fn sheet(
  State(app): State<Arc<App>>,
  BrainBody(asked): BrainBody<SheetAsk>,
) -> Answered<Json<Sheet>> {
  Ok(Json(Sheet {
    sheet: sheets::judge(&app.stages, &asked).await,
  }))
}
