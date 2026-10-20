//! The output gate (`docs/api.md`, 「Formats」): one part of a reply in the dialect's markdown, answered with
//! the markup it goes out as, or none to send its plain text.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use bmo_gate_client::{FormatAnswer, FormatAsk};
use gate_stages::output::decided as decide;

use crate::App;
use crate::answer::{Answered, Body};

pub async fn decided(
  State(app): State<Arc<App>>,
  Body(part): Body<FormatAsk>,
) -> Answered<Json<FormatAnswer>> {
  Ok(Json(FormatAnswer {
    markup: decide(&app.stages, part.room_id, &part.text).await,
  }))
}
