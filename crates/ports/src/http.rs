//! How every port reaches its unit (`docs/boundary-api.md`, 「Calls the gate makes」): the unit's base address and
//! token, a path built out of segments, a call waited for until it is answered or its connection is refused or
//! broken, and an answer read as the call's shape or as the unit's refusal.

use futures_util::{Stream, StreamExt};
use gate_codes::Code;
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode, Url};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// One unit as a port reaches it.
#[derive(Clone, Debug)]
pub struct Peer {
  base: Url,
  token: Option<String>,
}

impl Peer {
  /// The unit at a plain `http:` address, presenting `token` where one is given.
  pub fn new(address: &str, token: Option<String>) -> Result<Self, PortError> {
    let base = Url::parse(address).map_err(|_| PortError::NotAnAddress {
      address: address.to_owned(),
    })?;

    if base.scheme() != "http" || base.cannot_be_a_base() {
      return Err(PortError::NotAnAddress {
        address: address.to_owned(),
      });
    }

    Ok(Self { base, token })
  }
}

/// Why a call came to no answer of its shape. A refusal the unit answered is one of these too, with its
/// status, its code and its sentence as the unit gave them.
#[derive(Clone, Debug, PartialEq)]
pub enum PortError {
  /// The address given is no plain `http:` address a path can be added to.
  NotAnAddress { address: String },
  /// The call did not reach the unit, its connection refused or broken, or no answer came back.
  Unreachable {
    unit: &'static str,
    call: &'static str,
    why: String,
  },
  /// The unit refused the call.
  Refused {
    unit: &'static str,
    call: &'static str,
    status: u16,
    code: String,
    error: String,
  },
  /// The unit answered with a body that reads as neither the call's answer nor a refusal.
  Malformed {
    unit: &'static str,
    call: &'static str,
    status: u16,
    why: String,
  },
}

impl PortError {
  /// The gate's own code for the failure, as its routes hand it on.
  pub fn code(&self) -> Code {
    match self {
      PortError::NotAnAddress { .. } => Code::NotReady,
      _ => Code::UpstreamFailed,
    }
  }

  /// The unit's own code, where it refused.
  pub fn refused_with(&self) -> Option<&str> {
    match self {
      PortError::Refused { code, .. } => Some(code),
      _ => None,
    }
  }
}

impl std::fmt::Display for PortError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      PortError::NotAnAddress { address } => {
        write!(f, "{address} is not an http address a unit can be reached at")
      }
      PortError::Unreachable { unit, call, why } => write!(f, "{call}: {unit} did not answer: {why}"),
      PortError::Refused {
        unit,
        call,
        status,
        code,
        error,
      } => {
        write!(f, "{call}: {unit} refused with {status} {code}: {error}")
      }
      PortError::Malformed {
        unit,
        call,
        status,
        why,
      } => {
        write!(f, "{call}: {unit} answered {status} with a body that does not read: {why}")
      }
    }
  }
}

impl std::error::Error for PortError {}

/// What a call comes back with.
pub type Answer<T> = Result<T, PortError>;

/// The calls of one unit, made over HTTP.
#[derive(Clone, Debug)]
pub struct Caller {
  client: Client,
  peer: Peer,
  unit: &'static str,
}

impl Caller {
  pub fn new(unit: &'static str, peer: Peer) -> Self {
    Self {
      client: Client::new(),
      peer,
      unit,
    }
  }

  /// The address of a path of the unit's, built from its segments, each encoded as a segment.
  pub fn url(&self, segments: &[&str]) -> Url {
    let mut url = self.peer.base.clone();

    url
      .path_segments_mut()
      .expect("a peer's base is checked to take segments")
      .pop_if_empty()
      .extend(segments);
    url
  }

  fn request(&self, method: Method, segments: &[&str]) -> RequestBuilder {
    let request = self.client.request(method, self.url(segments));

    match &self.peer.token {
      Some(token) => request.bearer_auth(token),
      None => request,
    }
  }

  /// A request sent and waited for until the unit answers or the connection is refused or broken.
  async fn send(&self, call: &'static str, request: RequestBuilder) -> Answer<Response> {
    request.send().await.map_err(|why| self.unreachable(call, why))
  }

  /// The refusal a non-2xx answer carries, its sentence under `error` and its code under `code`.
  async fn refused(&self, call: &'static str, response: Response) -> PortError {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let said: Option<Value> = serde_json::from_str(&body).ok();
    let field = |name: &str| said.as_ref().and_then(|said| said.get(name)).and_then(Value::as_str);

    PortError::Refused {
      unit: self.unit,
      call,
      status,
      code: field("code").unwrap_or_default().to_owned(),
      error: field("error").map_or(body.clone(), str::to_owned),
    }
  }

  async fn read<T: DeserializeOwned>(&self, call: &'static str, response: Response) -> Answer<T> {
    let status = response.status();

    if !status.is_success() {
      return Err(self.refused(call, response).await);
    }

    let body = response.bytes().await.map_err(|why| self.unreachable(call, why))?;

    serde_json::from_slice(&body).map_err(|why| PortError::Malformed {
      unit: self.unit,
      call,
      status: status.as_u16(),
      why: why.to_string(),
    })
  }

  fn unreachable(&self, call: &'static str, why: reqwest::Error) -> PortError {
    PortError::Unreachable {
      unit: self.unit,
      call,
      why: why.to_string(),
    }
  }

  /// A read answered as `T`.
  pub async fn get<T: DeserializeOwned>(
    &self,
    call: &'static str,
    segments: &[&str],
    query: &[(&str, &str)],
  ) -> Answer<T> {
    let response = self.send(call, self.request(Method::GET, segments).query(query)).await?;

    self.read(call, response).await
  }

  /// A read answered as plain text.
  pub async fn get_text(
    &self,
    call: &'static str,
    segments: &[&str],
    query: &[(&str, &str)],
  ) -> Answer<String> {
    let response = self.send(call, self.request(Method::GET, segments).query(query)).await?;

    if !response.status().is_success() {
      return Err(self.refused(call, response).await);
    }

    response.text().await.map_err(|why| self.unreachable(call, why))
  }

  /// A body sent with `method` and answered as `T`.
  pub async fn send_json<B: Serialize + ?Sized, T: DeserializeOwned>(
    &self,
    call: &'static str,
    method: Method,
    segments: &[&str],
    body: &B,
  ) -> Answer<T> {
    let response = self.send(call, self.request(method, segments).json(body)).await?;

    self.read(call, response).await
  }

  /// A body posted and answered as `T`.
  pub async fn post<B: Serialize + ?Sized, T: DeserializeOwned>(
    &self,
    call: &'static str,
    segments: &[&str],
    body: &B,
  ) -> Answer<T> {
    self.send_json(call, Method::POST, segments, body).await
  }

  /// A body posted and answered as `T`, or none where the unit holds nothing there: a 404 with `code`.
  pub async fn post_or_nothing<B: Serialize + ?Sized, T: DeserializeOwned>(
    &self,
    call: &'static str,
    segments: &[&str],
    body: &B,
    nothing: &str,
  ) -> Answer<Option<T>> {
    match self.post(call, segments, body).await {
      Ok(answer) => Ok(Some(answer)),
      Err(PortError::Refused {
        status: 404, code, ..
      }) if code == nothing => Ok(None),
      Err(failure) => Err(failure),
    }
  }

  /// A body sent with `method` whose answer is only its success, whatever body comes with it.
  pub async fn done<B: Serialize + ?Sized>(
    &self,
    call: &'static str,
    method: Method,
    segments: &[&str],
    body: &B,
  ) -> Answer<()> {
    let response = self.send(call, self.request(method, segments).json(body)).await?;

    if response.status().is_success() {
      Ok(())
    } else {
      Err(self.refused(call, response).await)
    }
  }

  /// A call sent with `method` and no body, whose answer is only its success.
  pub async fn without(&self, call: &'static str, method: Method, segments: &[&str]) -> Answer<()> {
    let response = self.send(call, self.request(method, segments)).await?;

    if response.status().is_success() {
      Ok(())
    } else {
      Err(self.refused(call, response).await)
    }
  }

  /// A body posted and its answer read whole as text, whatever its status, with the status beside it.
  pub async fn post_text<B: Serialize + ?Sized>(
    &self,
    call: &'static str,
    segments: &[&str],
    body: &B,
  ) -> Answer<(StatusCode, String)> {
    let response = self.send(call, self.request(Method::POST, segments).json(body)).await?;
    let status = response.status();
    let text = response.text().await.map_err(|why| self.unreachable(call, why))?;

    Ok((status, text))
  }

  /// A stream of server-sent events, each its name and its data read as JSON.
  pub async fn events(
    &self,
    call: &'static str,
    segments: &[&str],
    query: &[(&str, &str)],
  ) -> Answer<impl Stream<Item = Answer<(String, Value)>> + use<>> {
    let response = self.send(call, self.request(Method::GET, segments).query(query)).await?;

    if !response.status().is_success() {
      return Err(self.refused(call, response).await);
    }

    let unit = self.unit;
    let stream =
      sse_stream::SseStream::from_bytes_stream(response.bytes_stream()).filter_map(
        move |event| async move {
          match event {
            Ok(event) => {
              let data = event.data?;
              let name = event.event.unwrap_or_else(|| "message".to_owned());

              Some(serde_json::from_str(&data).map(|data| (name, data)).map_err(|why| {
                PortError::Malformed {
                  unit,
                  call,
                  status: 200,
                  why: why.to_string(),
                }
              }))
            }
            Err(why) => Some(Err(PortError::Unreachable {
              unit,
              call,
              why: why.to_string(),
            })),
          }
        },
      );

    Ok(stream)
  }
}
