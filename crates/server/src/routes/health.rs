//! The service's health (`docs/api.md`, 「Health」): its version and whether its database answers.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use bmo_gate_client::Health;

use crate::App;

pub async fn health(State(app): State<Arc<App>>) -> Json<Health> {
  let db = &app.stages.runs.db;
  let ready = db.ping().await.is_ok();

  Json(Health {
    ready,
    reason: (!ready).then(|| "the database does not answer".to_owned()),
    version: bmo_version().to_owned(),
  })
}

/// The service's version: the set's version the build was made at, which the testbed hands the build as
/// `BMO_VERSION`, else the manifest's placeholder (bmo-chat's `docs/conventions.md`, 「Versions」).
pub fn bmo_version() -> &'static str {
  match option_env!("BMO_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
  }
}
