//! Every route the contract states (`docs/api.md`), one module a resource.

pub mod console;
pub mod documents;
pub mod events;
pub mod formats;
pub mod gates;
pub mod health;
pub mod judgements;
pub mod knowledge;
pub mod reference;
pub mod runs;
pub mod sanitiser;
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
    .route("/sanitised", post(sanitiser::sanitised))
    .route("/sanitiser/documents", post(sanitiser::document))
    .route("/translations", post(translations::translate))
    .route("/translations/kept", get(translations::kept).put(translations::keep))
    .route("/knowledge/selected", post(knowledge::selected))
    .route("/knowledge/work", post(knowledge::work))
    .route("/stages/{gateName}/runs", post(runs::run))
    .route("/formats/decided", post(formats::decided))
    .route("/trials", get(trials::list).post(trials::add))
    .route("/documents/sought", post(documents::sought))
    .route("/documents/translations", post(documents::translate))
    .route("/documents/translations/state", get(documents::state))
    .route("/documents/translations/parts", get(documents::parts))
    .route("/events", get(events::stream))
    .route("/health", get(health::health))
    .route("/console-manifest", get(console::manifest))
    .route("/console/words", get(console::words))
    .nest(crate::console::API_PREFIX, console::screens())
}
