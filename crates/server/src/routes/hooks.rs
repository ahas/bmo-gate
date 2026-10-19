//! For bmo-agency (`docs/boundary-api.md`, 「For bmo-agency: the session summariser」): the agency's hook point,
//! asked with `{point, ask}` and answered `{answer}`; an ask that does not read is answered the point's default.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use gate_runs::summary::{Closed, handover};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::App;

#[derive(Deserialize)]
struct Asked {
  ask: Closed,
}

pub async fn summariser(State(app): State<Arc<App>>, body: Bytes) -> Json<Value> {
  let Ok(Asked { ask }) = serde_json::from_slice::<Asked>(&body) else {
    eprintln!("gate-server: a summariser's ask did not read, so it is answered with nothing");
    return Json(json!({ "answer": null }));
  };

  Json(json!({ "answer": handover(&app.stages.runs, &ask).await }))
}
