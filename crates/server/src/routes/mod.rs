//! Every route the boundary states, one module a caller.

pub mod brain;
pub mod console;
pub mod documents;
pub mod events;
pub mod formats;
pub mod health;
pub mod hooks;
pub mod receiver;
pub mod rooms;
pub mod stages;
pub mod trials;
pub mod work;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post, put};

use crate::App;

/// Every route, by its method and path.
pub fn all() -> Router<Arc<App>> {
  Router::new()
    .route("/reference/selected", post(receiver::reference))
    .route("/sanitised", post(receiver::sanitised))
    .route("/judgements", post(receiver::judgement))
    .route("/judgements/attached", post(receiver::attached))
    .route("/options/copied", post(receiver::copied))
    .route("/translations/kept/read", post(work::kept))
    .route("/translations", post(work::translate))
    .route("/translations/kept", put(work::keep))
    .route("/knowledge/selected", post(work::selected))
    .route("/knowledge/work", post(work::for_work))
    .route("/sanitiser/documents", post(brain::document))
    .route("/sheets/judge", post(brain::sheet))
    .route("/hooks/session-summariser", post(hooks::summariser))
    .route("/formats/decided", post(formats::decided))
    .route("/stages/{stage}/runs", post(stages::run))
    .route("/gates", get(console::gates))
    .route("/options/{key}", get(console::options).post(console::change))
    .route("/rooms/{chat}/judgements", get(rooms::judgements))
    .route("/trials", post(trials::trial))
    .route("/trials/{stage}", get(trials::trials))
    .route("/laya", get(console::laya))
    .route("/documents/sought", post(documents::sought))
    .route("/documents/translations", post(documents::translate))
    .route("/documents/translations/state", get(documents::state))
    .route("/documents/translations/parts", get(documents::parts))
    .route("/events", get(events::stream))
    .route("/health", get(health::health))
}
