//! The bmo-job port (`docs/boundary-api.md`, 「bmo-job」): a row the gate raises for a job to look into. bmo-job
//! serves no route for it yet; the call is made as the boundary writes it, so it stands ready for the route
//! bmo-job adds, and until then its refusal is handed on as a refusal.

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::http::{Answer, Caller, Peer};

/// Every call the gate makes on bmo-job.
pub trait Job: Send + Sync {
  /// A row raised on the gate's judgement, in the room it reports to; the row's number.
  fn raise<'a>(&'a self, title: &'a str, judgement: &'a str, chat: i64) -> BoxFuture<'a, Answer<i64>>;
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
}

#[derive(Deserialize)]
struct Raised {
  id: i64,
}

impl Job for HttpJob {
  fn raise<'a>(&'a self, title: &'a str, judgement: &'a str, chat: i64) -> BoxFuture<'a, Answer<i64>> {
    Box::pin(async move {
      let raised: Raised = self
        .caller
        .post(
          "row raised",
          &["todos", "raised"],
          &Raise {
            title,
            judgement,
            chat,
          },
        )
        .await?;

      Ok(raised.id)
    })
  }
}
