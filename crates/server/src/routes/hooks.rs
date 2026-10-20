//! The agency's session-summariser hook (`docs/api.md`, 「Hooks」): asked with `{point, ask}` and answered
//! `{answer}`; an ask that does not read is answered the point's default.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use bmo_gate_client::HookAnswer;
use gate_runs::summary::{Closed, handover};
use serde::Deserialize;

use crate::App;

#[derive(Deserialize)]
struct Asked {
  ask: Closed,
}

pub async fn summariser(State(app): State<Arc<App>>, body: Bytes) -> Json<HookAnswer> {
  let Ok(Asked { ask }) = serde_json::from_slice::<Asked>(&body) else {
    eprintln!("gate-server: a summariser's ask did not read, so it is answered with nothing");
    return Json(HookAnswer { answer: None });
  };

  let note = handover(&app.stages.runs, &ask).await;

  Json(HookAnswer {
    answer: (!note.is_empty()).then_some(note),
  })
}
