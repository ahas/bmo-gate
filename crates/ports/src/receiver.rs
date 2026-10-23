//! The receiver port (`docs/boundary-api.md`, 「bmo-receiver」): the room facts the gate reads, the owner notice
//! the gate hands a fact to the chat agent by and one stored message, through the receiver's fixed API in the
//! common format — camelCase keys, times in epoch milliseconds, a list answered as a page — and the rows of each
//! round's draft process, read off the receiver's event stream.

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::PortError;
use crate::http::{Answer, Caller, Peer};

/// One room the receiver keeps: its chat, its title and the people that have stood as a sender in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomTitle {
  pub chat_id: i64,
  pub title: Option<String>,
  pub senders: Vec<i64>,
}

/// What kind of room a chat is, and whether it is a one-to-one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Roads {
  pub kind: String,
  pub one_to_one: bool,
}

/// Whether a person is the owner, and whether the owner spoke in a span.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerSpoke {
  pub owner: bool,
  pub spoke: bool,
}

/// One message the receiver keeps: who sent it where it knows, the name it went under, when in epoch
/// milliseconds, and its words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
  #[serde(default, rename = "senderId")]
  pub sender: Option<i64>,
  #[serde(default)]
  pub sender_name: Option<String>,
  pub sent_at: i64,
  pub text: String,
}

/// A person's display name, or none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Name {
  pub person: i64,
  pub name: Option<String>,
}

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

/// Every call the gate makes on the receiver.
pub trait Receiver: Send + Sync {
  /// Every room's chat, title and senders.
  fn titles(&self) -> BoxFuture<'_, Answer<Vec<RoomTitle>>>;

  /// The room's kind.
  fn roads(&self, chat: i64) -> BoxFuture<'_, Answer<Roads>>;

  /// Whether the person sent a message in the room between the two moments, both included.
  fn spoke_between(&self, chat: i64, person: i64, from: i64, to: i64) -> BoxFuture<'_, Answer<bool>>;

  /// Whether the person is the owner, and whether the owner spoke in the room in the `window_ms` before `before`.
  fn owner_spoke(
    &self,
    chat: i64,
    person: i64,
    before: i64,
    window_ms: i64,
  ) -> BoxFuture<'_, Answer<OwnerSpoke>>;

  /// The names the people's latest messages went under.
  fn names<'a>(&'a self, people: &'a [i64]) -> BoxFuture<'a, Answer<Vec<Name>>>;

  /// Whether the text waits for something to happen first.
  fn waits<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Answer<bool>>;

  /// The sender the agent's own words stand under in the room, or none.
  fn own_number<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Option<i64>>>;

  /// One stored message, or none where the receiver keeps no such message.
  fn message(&self, chat: i64, message: i64) -> BoxFuture<'_, Answer<Option<Message>>>;

  /// A fact handed to the chat agent in the owner's room, as a code and its fields.
  fn owner_notice<'a>(&'a self, code: &'a str, fields: &'a Map<String, Value>)
  -> BoxFuture<'a, Answer<()>>;

  /// The rows of the rounds' draft processes, from the ring the receiver replays as the stream opens.
  fn drafts(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<Drafted>>>>;
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

/// A list the receiver answers, one page of it.
#[derive(Deserialize)]
struct Page<T> {
  items: Vec<T>,
}

/// A room as the receiver's room list answers it, of which the gate reads its number, title and senders.
#[derive(Deserialize)]
struct Room {
  id: i64,
  title: Option<String>,
  senders: Vec<i64>,
}

#[derive(Deserialize)]
struct Spoke {
  spoke: bool,
}

#[derive(Deserialize)]
struct Person {
  id: i64,
  name: Option<String>,
}

#[derive(Serialize)]
struct Text<'a> {
  text: &'a str,
}

#[derive(Deserialize)]
struct Waits {
  waits: bool,
}

#[derive(Deserialize)]
struct Number {
  number: Option<i64>,
}

#[derive(Deserialize)]
struct Queued {
  #[allow(dead_code)]
  id: i64,
}

impl Receiver for HttpReceiver {
  fn titles(&self) -> BoxFuture<'_, Answer<Vec<RoomTitle>>> {
    Box::pin(async move {
      let rooms: Page<Room> = self.caller.get("room titles", &["rooms"], &[]).await?;

      Ok(
        rooms
          .items
          .into_iter()
          .map(|room| RoomTitle {
            chat_id: room.id,
            title: room.title,
            senders: room.senders,
          })
          .collect(),
      )
    })
  }

  fn roads(&self, chat: i64) -> BoxFuture<'_, Answer<Roads>> {
    Box::pin(
      async move { self.caller.get("room roads", &["rooms", &chat.to_string(), "roads"], &[]).await },
    )
  }

  fn spoke_between(&self, chat: i64, person: i64, from: i64, to: i64) -> BoxFuture<'_, Answer<bool>> {
    Box::pin(async move {
      let (person, from, to) = (person.to_string(), from.to_string(), to.to_string());
      let spoke: Spoke = self
        .caller
        .get(
          "spoke between",
          &["rooms", &chat.to_string(), "spoke-between"],
          &[("person", &person), ("from", &from), ("to", &to)],
        )
        .await?;

      Ok(spoke.spoke)
    })
  }

  fn owner_spoke(
    &self,
    chat: i64,
    person: i64,
    before: i64,
    window_ms: i64,
  ) -> BoxFuture<'_, Answer<OwnerSpoke>> {
    Box::pin(async move {
      let (person, before, window_ms) = (person.to_string(), before.to_string(), window_ms.to_string());

      self
        .caller
        .get(
          "owner spoke",
          &["rooms", &chat.to_string(), "owner-spoke"],
          &[("person", &person), ("before", &before), ("windowMs", &window_ms)],
        )
        .await
    })
  }

  fn names<'a>(&'a self, people: &'a [i64]) -> BoxFuture<'a, Answer<Vec<Name>>> {
    Box::pin(async move {
      if people.is_empty() {
        return Ok(Vec::new());
      }

      let ids = people.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
      let found: Page<Person> = self.caller.get("display names", &["people"], &[("ids", &ids)]).await?;

      Ok(
        found
          .items
          .into_iter()
          .map(|person| Name {
            person: person.id,
            name: person.name,
          })
          .collect(),
      )
    })
  }

  fn waits<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move {
      let waits: Waits =
        self.caller.post("waits on a happening", &["promise-readings"], &Text { text }).await?;

      Ok(waits.waits)
    })
  }

  fn own_number<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Option<i64>>> {
    Box::pin(async move {
      let number: Number = self
        .caller
        .get("own number", &["rooms", &chat.to_string(), "own-number"], &[("agentName", agent)])
        .await?;

      Ok(number.number)
    })
  }

  fn message(&self, chat: i64, message: i64) -> BoxFuture<'_, Answer<Option<Message>>> {
    Box::pin(async move {
      let (chat, message) = (chat.to_string(), message.to_string());

      match self.caller.get("a message", &["rooms", &chat, "messages", &message], &[]).await {
        Ok(found) => Ok(Some(found)),
        Err(PortError::Refused { status: 404, .. }) => Ok(None),
        Err(failure) => Err(failure),
      }
    })
  }

  fn owner_notice<'a>(
    &'a self,
    code: &'a str,
    fields: &'a Map<String, Value>,
  ) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      let mut body = fields.clone();

      body.insert("code".to_owned(), Value::String(code.to_owned()));

      let _: Queued = self.caller.post("owner notice", &["owner", "notices"], &body).await?;

      Ok(())
    })
  }

  fn drafts(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<Drafted>>>> {
    Box::pin(async move {
      let events = self.caller.events("draft rows", &["events"], &[]).await?;
      // A `draft` frame of kind `start` tells a question as it starts and carries none of a row's answer
      // fields, so it is let go by its kind before a row is read.
      let drafts = events
        .try_filter(|(_, data)| {
          futures_util::future::ready(data["type"] == "draft" && data["kind"] != "start")
        })
        .and_then(|(_, data)| {
          futures_util::future::ready(serde_json::from_value(data).map_err(|why| PortError::Malformed {
            unit: "bmo-receiver",
            call: "draft rows",
            status: 200,
            why: why.to_string(),
          }))
        });

      Ok(drafts.boxed())
    })
  }
}
