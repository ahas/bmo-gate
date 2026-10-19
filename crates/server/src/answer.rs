//! How a route answers and refuses (`docs/boundary-api.md`, 「Wire conventions」): a refusal is its status and
//! `{error, code}`, with `reason` beside a mode refusal, the code snake_case for the units' family and kebab-case
//! for the brain's; a body is read whole as JSON, one that is not JSON refused `body_not_json` and one that is not
//! the route's shape `field_wrong` naming why.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use gate_codes::Code;
use gate_runs::GateError;
use gate_runs::options::Refusal;
use serde::de::DeserializeOwned;
use serde_json::json;

/// A refusal: its code, the English sentence beside it, the mode refusal it is where it is one, and the family it is
/// spelt in.
#[derive(Debug)]
pub struct Refused {
  pub code: Code,
  pub error: String,
  pub reason: Option<Code>,
  pub kebab: bool,
}

impl Refused {
  pub fn new(code: Code, error: impl Into<String>) -> Self {
    Self {
      code,
      error: error.into(),
      reason: None,
      kebab: false,
    }
  }

  /// A gate option's change refused, with the mode refusal beside it where it is one.
  pub fn of_options(refusal: Refusal) -> Self {
    Self {
      reason: refusal.reason,
      ..Self::new(refusal.code, refusal.error)
    }
  }

  /// The same refusal as the brain's family spells it.
  pub fn kebab(mut self) -> Self {
    self.kebab = true;
    self
  }

  pub fn database(why: impl std::fmt::Display) -> Self {
    Self::new(Code::Database, format!("the gate's database failed: {why}"))
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
    let spelt = |code: Code| if self.kebab { code.kebab() } else { code.as_str().to_owned() };
    let mut body = json!({ "error": self.error, "code": spelt(self.code) });

    if let Some(reason) = self.reason {
      body["reason"] = spelt(reason).into();
    }

    (status, Json(body)).into_response()
  }
}

/// What a route answers: its body, or its refusal.
pub type Answered<T> = Result<T, Refused>;

fn read<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Refused> {
  let value: serde_json::Value = serde_json::from_slice(bytes)
    .map_err(|why| Refused::new(Code::BodyNotJson, format!("the body is not JSON: {why}")))?;

  serde_json::from_value(value)
    .map_err(|why| Refused::new(Code::FieldWrong, format!("the body is not as asked: {why}")))
}

/// A body of the units' family, read as `T`.
pub struct Body<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for Body<T> {
  type Rejection = Refused;

  async fn from_request(request: Request, state: &S) -> Result<Self, Refused> {
    let bytes = Bytes::from_request(request, state)
      .await
      .map_err(|why| Refused::new(Code::FieldWrong, format!("the body could not be read: {why}")))?;

    read(&bytes).map(Body)
  }
}

/// A body of the brain's family, read as `T`, its refusals spelt as the brain spells them.
pub struct BrainBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for BrainBody<T> {
  type Rejection = Refused;

  async fn from_request(request: Request, state: &S) -> Result<Self, Refused> {
    Body::<T>::from_request(request, state)
      .await
      .map(|Body(body)| BrainBody(body))
      .map_err(Refused::kebab)
  }
}

/// A query read as `T`, one that is not the route's shape refused `field_wrong`.
pub struct Query<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for Query<T> {
  type Rejection = Refused;

  async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Refused> {
    axum::extract::Query::<T>::from_request_parts(parts, state)
      .await
      .map(|axum::extract::Query(query)| Query(query))
      .map_err(|why| Refused::new(Code::FieldWrong, format!("the query is not as asked: {why}")))
  }
}
