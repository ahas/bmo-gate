//! The receiver port (`docs/boundary-api.md`, 「bmo-receiver」): the room facts the gate reads, through the
//! receiver's routes in the brain's family — camelCase bodies, every call a `POST` — the owner notice the gate
//! hands a fact to the chat agent by, one stored message, read through the route the receiver serves bmo-job
//! in its snake_case, and the rows of each round's draft process, read off the receiver's event stream.

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

/// One message the receiver keeps: who sent it where it knows, the name it went under, when, and its words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
  #[serde(default)]
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

  /// Whether the person is the owner, and whether the owner spoke in the room in the span before `before`.
  fn owner_spoke(
    &self,
    chat: i64,
    person: i64,
    before: i64,
    seconds: i64,
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

#[derive(Serialize)]
struct Nothing {}

#[derive(Deserialize)]
struct Titles {
  rooms: Vec<RoomTitle>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Room {
  chat_id: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Between {
  chat_id: i64,
  person: i64,
  from: i64,
  to: i64,
}

#[derive(Deserialize)]
struct Spoke {
  spoke: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Before {
  chat_id: i64,
  person: i64,
  before: i64,
  seconds: i64,
}

#[derive(Serialize)]
struct People<'a> {
  people: &'a [i64],
}

#[derive(Deserialize)]
struct Names {
  names: Vec<Name>,
}

#[derive(Serialize)]
struct Text<'a> {
  text: &'a str,
}

#[derive(Deserialize)]
struct Waits {
  waits: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRoom<'a> {
  agent: &'a str,
  chat_id: i64,
}

#[derive(Deserialize)]
struct Number {
  number: Option<i64>,
}

#[derive(Deserialize)]
struct Ok {
  #[allow(dead_code)]
  ok: bool,
}

impl Receiver for HttpReceiver {
  fn titles(&self) -> BoxFuture<'_, Answer<Vec<RoomTitle>>> {
    Box::pin(async move {
      let titles: Titles = self.caller.post("room titles", &["rooms", "titles"], &Nothing {}).await?;

      Ok(titles.rooms)
    })
  }

  fn roads(&self, chat: i64) -> BoxFuture<'_, Answer<Roads>> {
    Box::pin(
      async move { self.caller.post("room roads", &["rooms", "roads"], &Room { chat_id: chat }).await },
    )
  }

  fn spoke_between(&self, chat: i64, person: i64, from: i64, to: i64) -> BoxFuture<'_, Answer<bool>> {
    Box::pin(async move {
      let spoke: Spoke = self
        .caller
        .post(
          "spoke between",
          &["rooms", "spoke-between"],
          &Between {
            chat_id: chat,
            person,
            from,
            to,
          },
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
    seconds: i64,
  ) -> BoxFuture<'_, Answer<OwnerSpoke>> {
    Box::pin(async move {
      self
        .caller
        .post(
          "owner spoke",
          &["rooms", "owner-spoke"],
          &Before {
            chat_id: chat,
            person,
            before,
            seconds,
          },
        )
        .await
    })
  }

  fn names<'a>(&'a self, people: &'a [i64]) -> BoxFuture<'a, Answer<Vec<Name>>> {
    Box::pin(async move {
      let names: Names =
        self.caller.post("display names", &["people", "names"], &People { people }).await?;

      Ok(names.names)
    })
  }

  fn waits<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move {
      let waits: Waits =
        self.caller.post("waits on a happening", &["promises", "waits"], &Text { text }).await?;

      Ok(waits.waits)
    })
  }

  fn own_number<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Option<i64>>> {
    Box::pin(async move {
      let number: Number = self
        .caller
        .post(
          "own number",
          &["rooms", "own-number"],
          &AgentRoom {
            agent,
            chat_id: chat,
          },
        )
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

      let _: Ok = self.caller.post("owner notice", &["owner", "notice"], &body).await?;

      Ok(())
    })
  }

  fn drafts(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<Drafted>>>> {
    Box::pin(async move {
      let events = self.caller.events("draft rows", &["events"], &[]).await?;
      let drafts = events
        .try_filter(|(_, data)| futures_util::future::ready(data["type"] == "draft"))
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
