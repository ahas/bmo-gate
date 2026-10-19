//! For the chat units (`docs/boundary-api.md`, 「For the chat units: the output gate」): one part of a reply in the
//! dialect's markdown, answered with the markup it goes out as, or none to send its plain text.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use gate_stages::output::decided as decide;
use serde::{Deserialize, Serialize};

use crate::App;
use crate::answer::{Answered, Body};

#[derive(Deserialize)]
pub struct Part {
  pub chat: i64,
  pub text: String,
}

#[derive(Serialize)]
pub struct Markup {
  pub markup: Option<String>,
}

pub async fn decided(State(app): State<Arc<App>>, Body(part): Body<Part>) -> Answered<Json<Markup>> {
  Ok(Json(Markup {
    markup: decide(&app.stages, part.chat, &part.text).await,
  }))
}
