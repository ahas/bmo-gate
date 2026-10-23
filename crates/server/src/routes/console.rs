//! The console's routes (`docs/api.md`, 「Console」): the manifest and the words on the gate's token alone, and the
//! screens' routes under the API prefix, their module and stylesheet among them, behind the reader's role as well.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use bmo_gate_client::{ConsoleManifest, ConsoleRole};
use gate_codes::Code;
use serde_json::{Map, Value};

use crate::App;
use crate::answer::{Answered, Refused};
use crate::console::{ConsoleBundle, OWNER_ROLE, ROLE};
use crate::routes::{gates, trials};

fn served(app: &App) -> Answered<&ConsoleBundle> {
  app
    .console
    .as_ref()
    .ok_or_else(|| Refused::new(Code::NotFound, "the gate serves no console bundle"))
}

pub async fn manifest(State(app): State<Arc<App>>) -> Answered<Json<ConsoleManifest>> {
  Ok(Json(served(&app)?.manifest()))
}

pub async fn words(State(app): State<Arc<App>>) -> Answered<Json<Map<String, Value>>> {
  Ok(Json(served(&app)?.words.clone()))
}

/// The module or the stylesheet, answered as a file that never changes under its name.
pub async fn file(State(app): State<Arc<App>>, Path(name): Path<String>) -> Answered<Response> {
  let (file, media) = served(&app)?
    .file(&name)
    .ok_or_else(|| Refused::new(Code::NotFound, "no file of the console bundle has this name"))?;

  Ok(
    (
      [(CONTENT_TYPE, media), (CACHE_CONTROL, "public, max-age=31536000, immutable")],
      file.bytes.clone(),
    )
      .into_response(),
  )
}

/// The screens' floor: a call whose `Owner-Role` is missing or does not allow the manifest's role is refused.
async fn reader_role(request: Request, next: Next) -> Response {
  let held = request
    .headers()
    .get(OWNER_ROLE)
    .and_then(|value| value.to_str().ok())
    .and_then(ConsoleRole::named);

  match held {
    Some(role) if role.allows(ROLE) => next.run(request).await,
    Some(_) => {
      Refused::new(Code::Forbidden, "the reader's role does not open the gates' screens").into_response()
    }
    None => Refused::new(Code::Forbidden, "the call names no reader's role").into_response(),
  }
}

/// The screens' routes under the API prefix, each behind the reader's role.
pub fn screens() -> Router<Arc<App>> {
  Router::new()
    .route("/bundle/{file}", get(file))
    .route("/gates", get(gates::gates))
    .route("/laya", get(gates::laya))
    .route("/trials", get(trials::list).post(trials::add_from_console))
    .layer(middleware::from_fn(reader_role))
}
