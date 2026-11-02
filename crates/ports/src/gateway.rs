//! The agency's model gateway (`docs/boundary-api.md`, 「The model gateway」): a gate run on a registered model
//! is one chat completion with no tools and no session, waited for until the gateway answers, and the gateway's
//! key read from its file for each request.

use std::path::PathBuf;

use futures_util::future::BoxFuture;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::http::{Answer, Peer, PortError};

const UNIT: &str = "the model gateway";
const CALL: &str = "chat completion";

/// One request with no tools.
#[derive(Clone, Debug, PartialEq)]
pub struct Ask {
  /// The registration the request names as its model.
  pub model: String,
  /// The gate's instructions, the first message where they are not empty.
  pub system: String,
  pub input: String,
  pub max_tokens: i64,
  pub thinking: bool,
  /// The run's sampling, as the sampling header carries it, where the run names one.
  pub sampling: Option<String>,
}

/// What a completion answered: its text, where it gave one, and its usage as the gateway reported it.
#[derive(Clone, Debug, PartialEq)]
pub struct Completion {
  pub text: Option<String>,
  pub usage: Option<Value>,
}

/// The gateway's one call.
pub trait Gateway: Send + Sync {
  fn complete<'a>(&'a self, ask: &'a Ask) -> BoxFuture<'a, Answer<Completion>>;
}

/// The gateway over HTTP, at its address, with the key its file holds.
#[derive(Clone, Debug)]
pub struct HttpGateway {
  client: Client,
  peer: Peer,
  key_file: PathBuf,
}

impl HttpGateway {
  pub fn new(peer: Peer, key_file: PathBuf) -> Self {
    Self {
      client: Client::new(),
      peer,
      key_file,
    }
  }
}

#[derive(Serialize)]
struct Message<'a> {
  role: &'static str,
  content: &'a str,
}

#[derive(Serialize)]
struct Kwargs {
  enable_thinking: bool,
}

#[derive(Serialize)]
struct Body<'a> {
  model: &'a str,
  messages: Vec<Message<'a>>,
  max_tokens: i64,
  chat_template_kwargs: Kwargs,
}

#[derive(Deserialize)]
struct Answered {
  choices: Vec<Choice>,
  usage: Option<Value>,
}

#[derive(Deserialize)]
struct Choice {
  message: Said,
}

#[derive(Deserialize)]
struct Said {
  content: Option<String>,
}

impl Gateway for HttpGateway {
  fn complete<'a>(&'a self, ask: &'a Ask) -> BoxFuture<'a, Answer<Completion>> {
    Box::pin(async move {
      let key =
        std::fs::read_to_string(&self.key_file)
          .map(|key| key.trim().to_owned())
          .map_err(|why| PortError::Unreachable {
            unit: UNIT,
            call: CALL,
            why: format!("its key does not read: {why}"),
          })?;
      let mut messages = Vec::new();

      if !ask.system.is_empty() {
        messages.push(Message {
          role: "system",
          content: &ask.system,
        });
      }
      messages.push(Message {
        role: "user",
        content: &ask.input,
      });

      let body = Body {
        model: &ask.model,
        messages,
        max_tokens: ask.max_tokens,
        chat_template_kwargs: Kwargs {
          enable_thinking: ask.thinking,
        },
      };
      let caller = crate::http::Caller::new(UNIT, self.peer.clone());
      let mut request = self
        .client
        .post(caller.url(&["v1", "chat", "completions"]))
        .bearer_auth(key)
        .json(&body);

      if let Some(sampling) = &ask.sampling {
        request = request.header("x-bmo-sampling", sampling);
      }

      let response = request.send().await.map_err(|why| PortError::Unreachable {
        unit: UNIT,
        call: CALL,
        why: why.to_string(),
      })?;
      let status = response.status();
      let text = response.text().await.map_err(|why| PortError::Unreachable {
        unit: UNIT,
        call: CALL,
        why: why.to_string(),
      })?;

      if !status.is_success() {
        return Err(PortError::Refused {
          unit: UNIT,
          call: CALL,
          status: status.as_u16(),
          code: String::new(),
          error: text,
        });
      }

      let answered: Answered = serde_json::from_str(&text).map_err(|why| PortError::Malformed {
        unit: UNIT,
        call: CALL,
        status: status.as_u16(),
        why: why.to_string(),
      })?;

      Ok(Completion {
        text: answered.choices.into_iter().next().and_then(|choice| choice.message.content),
        usage: answered.usage,
      })
    })
  }
}
