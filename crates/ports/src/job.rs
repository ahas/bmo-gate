//! The bmo-job port (`docs/boundary-api.md`, 「bmo-job」): a row the gate raises for a job to look into. bmo-job
//! serves no route for it yet; the call is made as the boundary writes it, so it stands ready for the route
//! bmo-job adds, and until then its refusal is handed on as a refusal.

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::http::{Answer, Caller, Peer};

/// A row the gate asked for: its number, and whether it was raised now or stands open from an earlier ask under
/// the same key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Raised {
  pub id: i64,
  pub raised: bool,
}

/// Every call the gate makes on bmo-job.
pub trait Job: Send + Sync {
  /// A row raised on the gate's judgement, in the room it reports to, under the key that names what it is about;
  /// the row last raised under the key where that one still stands open.
  fn raise<'a>(
    &'a self,
    title: &'a str,
    judgement: &'a str,
    chat: i64,
    key: &'a str,
  ) -> BoxFuture<'a, Answer<Raised>>;
}

/// bmo-job over HTTP.
#[derive(Clone, Debug)]
pub struct HttpJob {
  caller: Caller,
}

impl HttpJob {
  pub fn new(peer: Peer) -> Self {
    Self {
      caller: Caller::new("bmo-job", peer),
    }
  }
}

#[derive(Serialize)]
struct Raise<'a> {
  title: &'a str,
  judgement: &'a str,
  chat: i64,
  key: &'a str,
}

impl Job for HttpJob {
  fn raise<'a>(
    &'a self,
    title: &'a str,
    judgement: &'a str,
    chat: i64,
    key: &'a str,
  ) -> BoxFuture<'a, Answer<Raised>> {
    Box::pin(async move {
      self
        .caller
        .post(
          "row raised",
          &["todos", "raised"],
          &Raise {
            title,
            judgement,
            chat,
            key,
          },
        )
        .await
    })
  }
}
