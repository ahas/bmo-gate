//! The receiver port (`docs/boundary-api.md`, 「bmo-receiver」): the rows of each round's draft process, read off the
//! receiver's event stream, and the audience a room calls for.

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};

use crate::PortError;
use crate::audience::Audience;
use crate::http::{Answer, Caller, Peer};

/// One row of a round's draft process, as the receiver's `draft` event tells it: the room, the round and the agent,
/// the row's number (0 the round's own turn), the question's name, its kind, how long its answer is, whether the
/// answer changed, how it ended and what the receiver said beside it. The answer itself is never told.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drafted {
  pub chat_id: i64,
  pub round: String,
  pub agent_name: String,
  pub number: i64,
  pub question: String,
  pub kind: String,
  pub answer_chars: i64,
  pub changed: bool,
  pub outcome: String,
  #[serde(default)]
  pub detail: Option<String>,
  pub ms: i64,
}

// A room's audience as the receiver answers it; its room and agent are the ones asked.
#[derive(Deserialize)]
struct RoomAudience {
  audience: Audience,
}

/// Every call the gate makes on the receiver.
pub trait Receiver: Send + Sync {
  /// The rows of the rounds' draft processes, from the ring the receiver replays as the stream opens.
  fn drafts(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<Drafted>>>>;

  /// The audience a room calls for when read for an agent: `External` where someone outside the company of the
  /// agent's owner sits there, or who sits there could not be read.
  fn audience<'a>(&'a self, room: i64, agent: &'a str) -> BoxFuture<'a, Answer<Audience>>;
}

/// The receiver over HTTP.
#[derive(Clone, Debug)]
pub struct HttpReceiver {
  caller: Caller,
}

impl HttpReceiver {
  pub fn new(peer: Peer) -> Self {
    Self {
      caller: Caller::new("bmo-receiver", peer),
    }
  }
}

impl Receiver for HttpReceiver {
  fn drafts(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<Drafted>>>> {
    Box::pin(async move {
      let events = self.caller.events("draft rows", &["events"], &[], None).await?;
      // A `draft` frame of kind `start` tells a question as it starts and carries none of a row's answer
      // fields, so it is let go by its kind before a row is read.
      let drafts = events
        .try_filter(|frame| {
          futures_util::future::ready(frame.data["type"] == "draft" && frame.data["kind"] != "start")
        })
        .and_then(|frame| {
          futures_util::future::ready(serde_json::from_value(frame.data).map_err(|why| {
            PortError::Malformed {
              unit: "bmo-receiver",
              call: "draft rows",
              status: 200,
              why: why.to_string(),
            }
          }))
        });

      Ok(drafts.boxed())
    })
  }

  fn audience<'a>(&'a self, room: i64, agent: &'a str) -> BoxFuture<'a, Answer<Audience>> {
    Box::pin(async move {
      let room = room.to_string();
      let answer: RoomAudience = self
        .caller
        .get("a room's audience", &["rooms", &room, "audience"], &[("agent", agent)])
        .await?;

      Ok(answer.audience)
    })
  }
}
