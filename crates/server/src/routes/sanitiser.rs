//! The sanitiser (`docs/api.md`, 「Sanitiser」): a text defused on its way into a model's context, and a document
//! an editor changed read for the text to keep.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use bmo_gate_client::{DocumentSanitiseAsk, DocumentSanitised, SanitiseAsk, Sanitised};
use gate_stages::sanitizer::{STAGE, sanitise};

use crate::App;
use crate::answer::{Answered, Body, Refused};

// A shelved sanitiser is never asked: the text stands as it came (docs/gates.md, 「Shelved」).
fn shelved() -> bool {
  gate_policy::gates::GATE_ORDER.is_shelved(STAGE)
}

pub async fn sanitised(
  State(app): State<Arc<App>>,
  Body(asked): Body<SanitiseAsk>,
) -> Answered<Json<Sanitised>> {
  if shelved() {
    return Ok(Json(Sanitised {
      text: asked.text,
      changed: false,
    }));
  }

  let safe = sanitise(&app.stages, &asked.text, &asked.label, asked.room_id, asked.message_id)
    .await
    .map_err(Refused::of_run)?;

  Ok(Json(Sanitised {
    text: safe.text,
    changed: safe.changed,
  }))
}

pub async fn document(
  State(app): State<Arc<App>>,
  Body(asked): Body<DocumentSanitiseAsk>,
) -> Answered<Json<DocumentSanitised>> {
  if shelved() {
    return Ok(Json(DocumentSanitised { text: asked.text }));
  }

  let label = format!("a document the brain is about to keep, {}", asked.path);
  let safe = sanitise(&app.stages, &asked.text, &label, None, None).await.map_err(Refused::of_run)?;

  Ok(Json(DocumentSanitised { text: safe.text }))
}
