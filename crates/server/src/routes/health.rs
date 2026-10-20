//! The service's health (`docs/api.md`, 「Health」): its version, whether its database answers, and Laya's last
//! state as the relay's last answer left it.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use bmo_gate_client::Health;
use gate_stages::laya_health;

use crate::App;

pub async fn health(State(app): State<Arc<App>>) -> Json<Health> {
  let db = &app.stages.runs.db;
  let ready = db.ping().await.is_ok();
  let laya = match laya_health::read(db).await.map(|health| health.state) {
    Ok(state) if state == "up" => "up",
    Ok(state) if state == "off" => "off",
    _ => "down",
  }
  .to_owned();

  Json(Health {
    ready,
    reason: (!ready).then(|| "the database does not answer".to_owned()),
    version: bmo_version().to_owned(),
    laya,
  })
}

/// The service's version, the workspace's.
pub fn bmo_version() -> &'static str {
  env!("CARGO_PKG_VERSION")
}
