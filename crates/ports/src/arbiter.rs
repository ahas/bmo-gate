//! The arbiter port (`docs/boundary-api.md`, 「bmo-arbiter」): the card master's placement of the Laya service
//! and its training, and what the service says of its units on a card. A card turn is asked on the node itself,
//! by the Laya server's own turn client, and is no call of this port's.

use futures_util::future::BoxFuture;
use reqwest::Method;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::http::{Answer, Caller, Peer, PortError};

/// What a placement request came to: the master's lines as it worked, and how it ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placed {
  pub lines: Vec<String>,
  pub ended: Ending,
}

/// How a placement request ended, as its last line says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ending {
  Done,
  Failed(String),
  /// The stream ended without its last line: a master that stopped mid-request, which undoes the request at
  /// its next start.
  Cut,
}

/// Every call the gate makes on the card master.
pub trait Arbiter: Send + Sync {
  /// A service placed on a node.
  fn place<'a>(&'a self, service: &'a str, node: &'a str) -> BoxFuture<'a, Answer<Placed>>;

  /// A service taken off a node.
  fn remove<'a>(&'a self, service: &'a str, node: &'a str) -> BoxFuture<'a, Answer<Placed>>;

  /// What a service says of its units, written whole in place of what it said before.
  fn describe<'a>(&'a self, service: &'a str, units: &'a Map<String, Value>) -> BoxFuture<'a, Answer<()>>;
}

/// The card master over HTTP.
#[derive(Clone, Debug)]
pub struct HttpArbiter {
  caller: Caller,
}

impl HttpArbiter {
  pub fn new(peer: Peer) -> Self {
    Self {
      caller: Caller::new("bmo-arbiter", peer),
    }
  }

  async fn request(
    &self,
    call: &'static str,
    path: &'static str,
    service: &str,
    node: &str,
  ) -> Answer<Placed> {
    let (status, text) = self.caller.post_text(call, &[path], &Placement { service, node }).await?;

    if !status.is_success() {
      return Err(PortError::Refused {
        unit: "bmo-arbiter",
        call,
        status: status.as_u16(),
        code: String::new(),
        error: text,
      });
    }

    Ok(placed(&text))
  }
}

/// The master's lines read: every line but the last one, and how the last one ended the request.
pub fn placed(text: &str) -> Placed {
  let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
  let ended = match lines.last().map(String::as_str) {
    Some("== done") => Ending::Done,
    Some(last) if last.starts_with("== failed: ") => {
      Ending::Failed(last.trim_start_matches("== failed: ").to_owned())
    }
    _ => Ending::Cut,
  };

  if ended != Ending::Cut {
    lines.pop();
  }

  Placed { lines, ended }
}

#[derive(Serialize)]
struct Placement<'a> {
  service: &'a str,
  node: &'a str,
}

#[derive(Serialize)]
struct Units<'a> {
  units: &'a Map<String, Value>,
}

impl Arbiter for HttpArbiter {
  fn place<'a>(&'a self, service: &'a str, node: &'a str) -> BoxFuture<'a, Answer<Placed>> {
    Box::pin(self.request("placement", "place", service, node))
  }

  fn remove<'a>(&'a self, service: &'a str, node: &'a str) -> BoxFuture<'a, Answer<Placed>> {
    Box::pin(self.request("removal", "remove", service, node))
  }

  fn describe<'a>(&'a self, service: &'a str, units: &'a Map<String, Value>) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      self
        .caller
        .done("units described", Method::PUT, &["descriptions", service], &Units { units })
        .await
    })
  }
}
