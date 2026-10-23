//! How a route answers and refuses (`docs/api.md`, 「Errors」): a refusal is its status and `{code, error}`, the
//! code kebab-case. A body is read whole as JSON, one that is not JSON or not the route's shape refused
//! `bad-request` naming why.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::header::RETRY_AFTER;
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bmo_gate_client::ErrorBody;
use gate_codes::Code;
use gate_runs::GateError;
use gate_runs::options::Refusal;
use serde::de::DeserializeOwned;

/// A refusal: its code and the English sentence beside it, and the seconds a caller waits before asking again
/// where the refusal names them.
#[derive(Debug)]
pub struct Refused {
  pub code: Code,
  pub error: String,
  pub retry_after: Option<u64>,
}

impl Refused {
  pub fn new(code: Code, error: impl Into<String>) -> Self {
    Self {
      code,
      error: error.into(),
      retry_after: None,
    }
  }

  /// The same refusal, naming the seconds to wait in `Retry-After`.
  pub fn retry_after(self, seconds: u64) -> Self {
    Self {
      retry_after: Some(seconds),
      ..self
    }
  }

  /// A gate option's change refused.
  pub fn of_options(refusal: Refusal) -> Self {
    Self::new(refusal.code, refusal.error)
  }

  pub fn database(why: impl std::fmt::Display) -> Self {
    Self::new(Code::Failed, format!("the gate's database failed: {why}"))
  }

  pub fn failed(why: impl std::fmt::Display) -> Self {
    Self::new(Code::Failed, format!("the gate failed: {why}"))
  }

  /// A gate run's failure: a stop as `stopped`, any other as the gate failing.
  pub fn of_run(why: GateError) -> Self {
    match why {
      GateError::Stopped(why) => Self::new(Code::Stopped, format!("the run was stopped: {why}")),
      GateError::Fault(why) => Self::failed(why),
    }
  }
}

impl IntoResponse for Refused {
  fn into_response(self) -> Response {
    let status = StatusCode::from_u16(self.code.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = ErrorBody {
      code: self.code.as_str().to_owned(),
      error: self.error,
    };
    let mut response = (status, Json(body)).into_response();

    if let Some(seconds) = self.retry_after {
      response.headers_mut().insert(RETRY_AFTER, HeaderValue::from(seconds));
    }

    response
  }
}

/// What a route answers: its body, or its refusal.
pub type Answered<T> = Result<T, Refused>;

fn read<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Refused> {
  let value: serde_json::Value = serde_json::from_slice(bytes)
    .map_err(|why| Refused::new(Code::BadRequest, format!("the body is not JSON: {why}")))?;

  serde_json::from_value(value)
    .map_err(|why| Refused::new(Code::BadRequest, format!("the body is not as asked: {why}")))
}

/// A JSON body, read as `T`.
pub struct Body<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for Body<T> {
  type Rejection = Refused;

  async fn from_request(request: Request, state: &S) -> Result<Self, Refused> {
    let bytes = Bytes::from_request(request, state)
      .await
      .map_err(|why| Refused::new(Code::BadRequest, format!("the body could not be read: {why}")))?;

    read(&bytes).map(Body)
  }
}

/// A query read as `T`, one that is not the route's shape refused `bad-request`.
pub struct Query<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for Query<T> {
  type Rejection = Refused;

  async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Refused> {
    axum::extract::Query::<T>::from_request_parts(parts, state)
      .await
      .map(|axum::extract::Query(query)| Query(query))
      .map_err(|why| Refused::new(Code::BadRequest, format!("the query is not as asked: {why}")))
  }
}
