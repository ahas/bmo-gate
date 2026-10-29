//! The client: one call for every route the gate serves, through the contract's own types.

use std::time::Duration;

use futures_util::{Stream, StreamExt};
use reqwest::header::{ACCEPT, AUTHORIZATION};
use reqwest::{Method, RequestBuilder, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sse_stream::SseStream;
use url::Url;

use crate::types::*;

/// How long a call waits for its answer beyond the wait it asked the gate for.
const ANSWER_WITHIN: Duration = Duration::from_secs(30);

/// What a call came to short of the route's answer.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ClientFailure {
  /// Nothing answered at the gate's address.
  #[error("the gate could not be reached: {0}")]
  Unreachable(String),
  /// The gate answered with a status other than the route's, and the error body where it sent one.
  #[error("the gate answered {status}: {}", answer.as_ref().map_or(body.as_str(), |answer| answer.error.as_str()))]
  Answered {
    status: u16,
    answer: Option<ErrorBody>,
    body: String,
  },
  /// The answer was not of the route's shape.
  #[error("the gate's answer could not be read: {0}")]
  Unreadable(String),
}

impl ClientFailure {
  /// The code the gate refused with, where it answered one.
  pub fn code(&self) -> Option<&str> {
    match self {
      Self::Answered {
        answer: Some(answer),
        ..
      } => Some(&answer.code),
      _ => None,
    }
  }

  /// The status the gate answered with, where it answered.
  pub fn status(&self) -> Option<u16> {
    match self {
      Self::Answered { status, .. } => Some(*status),
      _ => None,
    }
  }
}

/// A client of one gate service, at its address and with its token.
#[derive(Debug, Clone)]
pub struct GateClient {
  base: Url,
  token: String,
  http: reqwest::Client,
}

impl GateClient {
  /// A client of the gate whose routes stand at `base`, sending `token` as its bearer token.
  pub fn new(base: &str, token: impl Into<String>) -> Result<Self, ClientFailure> {
    let mut base =
      Url::parse(base).map_err(|error| ClientFailure::Unreachable(format!("{base}: {error}")))?;
    if base.cannot_be_a_base() {
      return Err(ClientFailure::Unreachable(format!("{base} cannot carry paths")));
    }
    if !base.path().ends_with('/') {
      let path = format!("{}/", base.path());
      base.set_path(&path);
    }
    let http = reqwest::Client::builder()
      .connect_timeout(Duration::from_secs(10))
      .build()
      .map_err(|error| ClientFailure::Unreachable(error.to_string()))?;

    Ok(Self {
      base,
      token: token.into(),
      http,
    })
  }

  fn url(&self, segments: &[&str]) -> Url {
    let mut url = self.base.clone();
    {
      let mut path = url.path_segments_mut().expect("the base carries paths");
      path.pop_if_empty();
      path.extend(segments);
    }
    url
  }

  fn request(&self, method: Method, segments: &[&str]) -> RequestBuilder {
    self
      .http
      .request(method, self.url(segments))
      .header(AUTHORIZATION, format!("Bearer {}", self.token))
      .timeout(ANSWER_WITHIN)
  }

  fn get(&self, segments: &[&str]) -> RequestBuilder {
    self.request(Method::GET, segments)
  }

  fn post(&self, segments: &[&str]) -> RequestBuilder {
    self.request(Method::POST, segments)
  }

  fn put(&self, segments: &[&str]) -> RequestBuilder {
    self.request(Method::PUT, segments)
  }

  /// Readiness and version.
  pub async fn health(&self) -> Result<Health, ClientFailure> {
    answer(self.get(&["health"])).await
  }

  /// The gate order.
  pub async fn gates(&self) -> Result<Page<Gate>, ClientFailure> {
    answer(self.get(&["gates"])).await
  }

  /// One gate's options.
  pub async fn gate_options(&self, gate_name: &str) -> Result<GateOptions, ClientFailure> {
    answer(self.get(&["options", gate_name])).await
  }

  /// Change one gate's options.
  pub async fn change_gate_options(
    &self,
    gate_name: &str,
    change: &GateOptionChange,
  ) -> Result<GateOptionsChanged, ClientFailure> {
    answer(self.post(&["options", gate_name]).json(change)).await
  }

  /// Change one gate's options for one agent, leaving every other agent's as they stand.
  pub async fn change_agent_gate_options(
    &self,
    gate_name: &str,
    agent_name: &str,
    change: &GateOptionChange,
  ) -> Result<GateOptionsChanged, ClientFailure> {
    answer(self.post(&["options", gate_name, "agents", agent_name]).json(change)).await
  }

  /// Copy the chat agent's rows under a companion's name.
  pub async fn copy_options(&self, copied: &OptionsCopied) -> Result<(), ClientFailure> {
    empty(self.post(&["options", "copied"]).json(copied)).await
  }

  /// A page of judgements, newest first.
  pub async fn judgements(&self, query: &JudgementQuery) -> Result<Page<Judgement>, ClientFailure> {
    answer(self.get(&["judgements"]).query(query)).await
  }

  /// Write one judgement.
  pub async fn add_judgement(&self, judgement: &NewJudgement) -> Result<Judgement, ClientFailure> {
    answer(self.post(&["judgements"]).json(judgement)).await
  }

  /// Put a round's judgements under the message that answered it.
  pub async fn attach_judgements(&self, attach: &AttachJudgements) -> Result<(), ClientFailure> {
    empty(self.post(&["judgements", "attached"]).json(attach)).await
  }

  /// The pieces a turn is handed.
  pub async fn reference(&self, ask: &ReferenceAsk) -> Result<ReferenceAnswer, ClientFailure> {
    answer(self.post(&["reference", "selected"]).json(ask)).await
  }

  /// The brain's index for an agent in a room.
  pub async fn reference_index(
    &self,
    query: &ReferenceIndexQuery,
  ) -> Result<ReferenceIndex, ClientFailure> {
    answer(self.get(&["reference", "index"]).query(query)).await
  }

  /// One piece of the index read whole.
  pub async fn reference_piece(
    &self,
    slug: &str,
    query: &ReferencePieceQuery,
  ) -> Result<ReferencePiece, ClientFailure> {
    answer(self.get(&["reference", "pieces", slug]).query(query)).await
  }

  /// The index's entries whose words match a query.
  pub async fn reference_search(
    &self,
    query: &ReferenceSearchQuery,
  ) -> Result<ReferenceSearch, ClientFailure> {
    answer(self.get(&["reference", "search"]).query(query)).await
  }

  /// Translate originals into one language.
  pub async fn translate(&self, ask: &TranslationAsk) -> Result<Readings, ClientFailure> {
    answer(self.post(&["translations"]).json(ask)).await
  }

  /// The translations kept for some originals.
  pub async fn kept_translations(&self, query: &KeptQuery) -> Result<Page<KeptTranslation>, ClientFailure> {
    answer(self.get(&["translations", "kept"]).query(query)).await
  }

  /// Keep one translation.
  pub async fn keep_translation(&self, ask: &KeepTranslation) -> Result<KeptTranslation, ClientFailure> {
    answer(self.put(&["translations", "kept"]).json(ask)).await
  }

  /// One run of one gate.
  pub async fn run_stage(&self, gate_name: &str, ask: &StageRunAsk) -> Result<StageRun, ClientFailure> {
    answer(self.post(&["stages", gate_name, "runs"]).json(ask)).await
  }

  /// The markup one part of a reply goes out as.
  /// A page of trials, oldest first.
  pub async fn trials(&self, query: &TrialQuery) -> Result<Page<Trial>, ClientFailure> {
    answer(self.get(&["trials"]).query(query)).await
  }

  /// Put one prompt to one gate and keep the trial.
  pub async fn add_trial(&self, ask: &NewTrial) -> Result<Trial, ClientFailure> {
    answer(self.post(&["trials"]).json(ask)).await
  }

  /// Queue a document's translation.
  pub async fn add_document_translation(
    &self,
    order: &DocumentTranslationOrder,
  ) -> Result<Taken, ClientFailure> {
    answer(self.post(&["documents", "translations"]).json(order)).await
  }

  /// Where a document's translation stands.
  pub async fn document_translation_state(
    &self,
    query: &DocumentStateQuery,
  ) -> Result<DocumentTranslationState, ClientFailure> {
    answer(self.get(&["documents", "translations", "state"]).query(query)).await
  }

  /// A document's translated parts.
  pub async fn document_translation_parts(
    &self,
    query: &DocumentPartsQuery,
  ) -> Result<Page<DocumentPart>, ClientFailure> {
    answer(self.get(&["documents", "translations", "parts"]).query(query)).await
  }

  /// The event stream as it comes, from the event `after` names or from now.
  pub async fn events(
    &self,
    after: Option<i64>,
  ) -> Result<impl Stream<Item = Result<Event, ClientFailure>> + Send + 'static, ClientFailure> {
    let mut request = self
      .get(&["events"])
      .header(ACCEPT, "text/event-stream")
      .query(&[("after", after.unwrap_or_default())]);
    if let Some(after) = after {
      request = request.header("Last-Event-ID", after.to_string());
    }
    let response = request.send().await.map_err(|error| ClientFailure::Unreachable(error.to_string()))?;
    let response = checked(response).await?;
    let stream = SseStream::from_bytes_stream(response.bytes_stream()).filter_map(|event| async move {
      match event {
        Err(error) => Some(Err(ClientFailure::Unreadable(error.to_string()))),
        // A comment line keeps the stream open and carries no event.
        Ok(event) => event.data.map(|data| {
          serde_json::from_str::<Event>(&data).map_err(|error| ClientFailure::Unreadable(error.to_string()))
        }),
      }
    });
    Ok(stream)
  }
}

async fn checked(response: Response) -> Result<Response, ClientFailure> {
  let status = response.status();
  if status.is_success() {
    return Ok(response);
  }

  let body = response.text().await.unwrap_or_default();
  let answer = serde_json::from_str::<ErrorBody>(&body).ok();
  Err(ClientFailure::Answered {
    status: status.as_u16(),
    answer,
    body,
  })
}

async fn answer<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, ClientFailure> {
  let response = request.send().await.map_err(|error| ClientFailure::Unreachable(error.to_string()))?;
  let response = checked(response).await?;
  response.json::<T>().await.map_err(|error| ClientFailure::Unreadable(error.to_string()))
}

async fn empty(request: RequestBuilder) -> Result<(), ClientFailure> {
  let response = request.send().await.map_err(|error| ClientFailure::Unreachable(error.to_string()))?;
  checked(response).await?;
  Ok(())
}

/// A body written as JSON without a type of its own, for a call whose body is built by the caller.
pub fn json<T: Serialize>(value: &T) -> Result<serde_json::Value, ClientFailure> {
  serde_json::to_value(value).map_err(|error| ClientFailure::Unreadable(error.to_string()))
}
