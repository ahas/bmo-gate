//! Every route the contract states (`docs/api.md`), one module a resource.

pub mod documents;
pub mod events;
pub mod formats;
pub mod gates;
pub mod health;
pub mod judgements;
pub mod reference;
pub mod runs;
pub mod translations;
pub mod trials;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};

use crate::App;

/// Every route, by its method and path.
pub fn all() -> Router<Arc<App>> {
  Router::new()
    .route("/gates", get(gates::gates))
    .route("/options/{gateName}", get(gates::options).post(gates::change))
    .route("/options/copied", post(gates::copy))
    .route("/options/{gateName}/agents/{agentName}", post(gates::change_for))
    .route("/laya", get(gates::laya))
    .route("/judgements", get(judgements::list).post(judgements::add))
    .route("/judgements/attached", post(judgements::attached))
    .route("/reference/selected", post(reference::reference))
    .route("/reference/index", get(reference::index))
    .route("/reference/pieces/{slug}", get(reference::piece))
    .route("/reference/search", get(reference::search))
    .route("/translations", post(translations::translate))
    .route("/translations/kept", get(translations::kept).put(translations::keep))
    .route("/stages/{gateName}/runs", post(runs::run))
    .route("/formats/decided", post(formats::decided))
    .route("/trials", get(trials::list).post(trials::add))
    .route("/documents/translations", post(documents::translate))
    .route("/documents/translations/state", get(documents::state))
    .route("/documents/translations/parts", get(documents::parts))
    .route("/events", get(events::stream))
    .route("/health", get(health::health))
}
