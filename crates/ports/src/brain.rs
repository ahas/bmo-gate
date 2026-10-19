//! The brain port (`docs/boundary-api.md`, 「bmo-brain」): the raw material a turn's reference is picked from
//! and the facts the gate hands back, in the brain's conventions — camelCase bodies, every call a `POST`, and a
//! refusal answered as an answer.

use futures_util::future::BoxFuture;
use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::http::{Answer, Caller, Peer};

/// A request the brain understood and did not carry out: its code, its English sentence and the code's own
/// fields.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Refusal {
  pub code: String,
  pub message: String,
  #[serde(flatten)]
  pub fields: Map<String, Value>,
}

/// What a call the brain may refuse comes back with.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply<T> {
  Answered(T),
  Refused(Refusal),
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for Reply<T> {
  fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    let body = Value::deserialize(deserializer)?;

    if body.get("answered") == Some(&Value::Bool(false)) {
      let refusal = body.get("refusal").cloned().ok_or_else(|| D::Error::missing_field("refusal"))?;

      return serde_json::from_value(refusal).map(Reply::Refused).map_err(D::Error::custom);
    }

    serde_json::from_value(body).map(Reply::Answered).map_err(D::Error::custom)
  }
}

/// An event a turn carries, and the item it is about where it is about one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
  pub kind: String,
  pub item: Option<i64>,
}

/// One memory row, whole.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRow {
  pub id: i64,
  pub agent: String,
  pub slug: String,
  #[serde(rename = "type")]
  pub kind: String,
  pub chat_id: Option<i64>,
  pub reach: String,
  pub condition: String,
  pub action: String,
  pub for_user: Option<i64>,
  pub message_id: Option<i64>,
  pub todo_id: Option<i64>,
  pub set_by: Option<i64>,
  pub set_at: i64,
  pub active: bool,
  pub last_hit_at: Option<i64>,
  pub hits: i64,
  pub done_at: Option<i64>,
  pub done_text: Option<String>,
  pub down_reason: Option<String>,
  pub down_at: Option<i64>,
  pub candidate_why: Option<String>,
  pub candidate_at: Option<i64>,
  pub event: Option<Event>,
  pub event_met_at: Option<i64>,
  pub moved_at: Option<i64>,
}

/// A row with a condition, as the matcher is offered it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Condition {
  pub slug: String,
  pub condition: String,
  pub action: String,
}

/// One fragment row as a gate is offered it, whole.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fragment {
  pub kind: String,
  pub chat_id: Option<i64>,
  pub owner: Option<i64>,
  pub agent: String,
  pub all_agents: bool,
  pub slug: String,
  pub title: String,
  pub path: String,
  pub scope: Option<String>,
  pub position: i64,
  pub active: bool,
  pub last_hit_at: Option<i64>,
  pub hits: i64,
  pub set_by: Option<i64>,
  pub set_at: i64,
  pub hand: Option<bool>,
  pub hand_at: Option<i64>,
  pub keywords: Vec<String>,
  pub items: Vec<i64>,
  pub written_on: Option<String>,
  pub confirmed_on: Option<String>,
  pub status: String,
  pub body_hash: Option<String>,
}

/// A fragment row a turn attached, found by these four among the rows the turn's agent may read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
  pub kind: String,
  pub chat_id: Option<i64>,
  pub owner: Option<i64>,
  pub slug: String,
}

/// A knowledge chunk read, by its slug, path, text and version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
  pub slug: String,
  pub path: String,
  pub text: String,
  pub version: String,
}

/// One standing sheet: the person, its part, its path, its text and its version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sheet {
  pub person: i64,
  pub part: String,
  pub path: String,
  pub text: String,
  pub version: String,
}

/// One person-book piece read, with whose it is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeoplePiece {
  pub slug: String,
  pub path: String,
  pub text: String,
  pub version: String,
  pub owner: Option<i64>,
}

/// What the person book answers a turn: the speakers' sheets and the pieces asked for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct People {
  pub sheets: Vec<Sheet>,
  pub pieces: Vec<PeoplePiece>,
}

/// One rule the owner grants in a room.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomRule {
  pub id: String,
  pub subject: i64,
  pub text: String,
}

/// One document a session holds, by its path and version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Load {
  pub path: String,
  pub version: String,
}

/// Every call the gate makes on the brain.
pub trait Brain: Send + Sync {
  /// The room's open rows that wait on nothing, and the errands whose event has come.
  fn standing<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Vec<MemoryRow>>>;

  /// The rows with a condition the matcher is offered for the room.
  fn conditions<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Vec<Condition>>>;

  /// What the matcher made of the room's rows: the ones it matched and the ones it spent.
  fn matched<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    matched: &'a [String],
    spent: &'a [String],
  ) -> BoxFuture<'a, Answer<()>>;

  /// The rows the turn's events wake.
  fn woken<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    events: &'a [Event],
  ) -> BoxFuture<'a, Answer<Vec<MemoryRow>>>;

  /// The active fragment rows of the kinds named the turn's agent may be offered in the room.
  fn offered<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    kinds: &'a [String],
  ) -> BoxFuture<'a, Answer<Vec<Fragment>>>;

  /// The rows a turn attached, their counts raised.
  fn hits<'a>(&'a self, agent: &'a str, chat: i64, attached: &'a [Hit]) -> BoxFuture<'a, Answer<()>>;

  /// The knowledge chunks asked for, in the order asked, or the brain's refusal of a slug outside the room.
  fn knowledge<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<Vec<Document>>>>;

  /// The speakers' sheets and the person-book pieces asked for, or the brain's refusal of a slug outside the
  /// room.
  fn people<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    senders: &'a [i64],
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<People>>>;

  /// The rules the owner grants in the room.
  fn room_rules(&self, chat: i64) -> BoxFuture<'_, Answer<Vec<RoomRule>>>;

  /// What a session already holds.
  fn loads<'a>(&'a self, session: &'a str) -> BoxFuture<'a, Answer<Vec<Load>>>;

  /// A room's withering stamps let go.
  fn forgotten(&self, chat: i64) -> BoxFuture<'_, Answer<()>>;
}

/// The brain over HTTP.
#[derive(Clone, Debug)]
pub struct HttpBrain {
  caller: Caller,
}

impl HttpBrain {
  pub fn new(peer: Peer) -> Self {
    Self {
      caller: Caller::new("bmo-brain", peer),
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRoom<'a> {
  agent: &'a str,
  chat_id: i64,
}

#[derive(Deserialize)]
struct Rows<T> {
  rows: Vec<T>,
}

#[derive(Deserialize)]
struct Ok {
  #[allow(dead_code)]
  ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Matched<'a> {
  agent: &'a str,
  chat_id: i64,
  matched: &'a [String],
  spent: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Woken<'a> {
  agent: &'a str,
  chat_id: i64,
  events: &'a [Event],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Offer<'a> {
  agent: &'a str,
  chat_id: i64,
  kinds: &'a [String],
}

#[derive(Deserialize)]
struct Fragments {
  fragments: Vec<Fragment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hits<'a> {
  agent: &'a str,
  chat_id: i64,
  attached: &'a [Hit],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Read<'a> {
  agent: &'a str,
  chat_id: i64,
  #[serde(skip_serializing_if = "Option::is_none")]
  senders: Option<&'a [i64]>,
  slugs: &'a [String],
}

#[derive(Deserialize)]
struct Documents {
  documents: Vec<Document>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Room {
  chat_id: i64,
}

#[derive(Deserialize)]
struct Rules {
  rules: Vec<RoomRule>,
}

#[derive(Serialize)]
struct Session<'a> {
  session: &'a str,
}

#[derive(Deserialize)]
struct Loads {
  loads: Vec<Load>,
}

impl HttpBrain {
  async fn post<B: Serialize, T: DeserializeOwned>(
    &self,
    call: &'static str,
    path: &str,
    body: &B,
  ) -> Answer<T> {
    let segments: Vec<&str> = path.split('/').collect();

    self.caller.post(call, &segments, body).await
  }
}

impl Brain for HttpBrain {
  fn standing<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      let rows: Rows<MemoryRow> = self
        .post(
          "standing rows",
          "memory/standing",
          &AgentRoom {
            agent,
            chat_id: chat,
          },
        )
        .await?;

      Ok(rows.rows)
    })
  }

  fn conditions<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Vec<Condition>>> {
    Box::pin(async move {
      let rows: Rows<Condition> = self
        .post(
          "conditional rows",
          "memory/conditions",
          &AgentRoom {
            agent,
            chat_id: chat,
          },
        )
        .await?;

      Ok(rows.rows)
    })
  }

  fn matched<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    matched: &'a [String],
    spent: &'a [String],
  ) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      let _: Ok = self
        .post(
          "matched rows",
          "memory/matched",
          &Matched {
            agent,
            chat_id: chat,
            matched,
            spent,
          },
        )
        .await?;

      Ok(())
    })
  }

  fn woken<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    events: &'a [Event],
  ) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      let rows: Rows<MemoryRow> = self
        .post(
          "rows woken",
          "memory/events",
          &Woken {
            agent,
            chat_id: chat,
            events,
          },
        )
        .await?;

      Ok(rows.rows)
    })
  }

  fn offered<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    kinds: &'a [String],
  ) -> BoxFuture<'a, Answer<Vec<Fragment>>> {
    Box::pin(async move {
      let offered: Fragments = self
        .post(
          "fragments offered",
          "fragments/offer",
          &Offer {
            agent,
            chat_id: chat,
            kinds,
          },
        )
        .await?;

      Ok(offered.fragments)
    })
  }

  fn hits<'a>(&'a self, agent: &'a str, chat: i64, attached: &'a [Hit]) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      let _: Ok = self
        .post(
          "fragments attached",
          "fragments/hits",
          &Hits {
            agent,
            chat_id: chat,
            attached,
          },
        )
        .await?;

      Ok(())
    })
  }

  fn knowledge<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<Vec<Document>>>> {
    Box::pin(async move {
      let read: Reply<Documents> = self
        .post(
          "knowledge read",
          "knowledge/read",
          &Read {
            agent,
            chat_id: chat,
            senders: None,
            slugs,
          },
        )
        .await?;

      Ok(match read {
        Reply::Answered(read) => Reply::Answered(read.documents),
        Reply::Refused(refusal) => Reply::Refused(refusal),
      })
    })
  }

  fn people<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    senders: &'a [i64],
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<People>>> {
    Box::pin(async move {
      self
        .post(
          "person book read",
          "people/read",
          &Read {
            agent,
            chat_id: chat,
            senders: Some(senders),
            slugs,
          },
        )
        .await
    })
  }

  fn room_rules(&self, chat: i64) -> BoxFuture<'_, Answer<Vec<RoomRule>>> {
    Box::pin(async move {
      let rules: Rules = self.post("room rules read", "room-rules/read", &Room { chat_id: chat }).await?;

      Ok(rules.rules)
    })
  }

  fn loads<'a>(&'a self, session: &'a str) -> BoxFuture<'a, Answer<Vec<Load>>> {
    Box::pin(async move {
      let loads: Loads = self.post("session loads", "sessions/loads", &Session { session }).await?;

      Ok(loads.loads)
    })
  }

  fn forgotten(&self, chat: i64) -> BoxFuture<'_, Answer<()>> {
    Box::pin(async move {
      let _: Ok = self.post("room forgotten", "rooms/forgotten", &Room { chat_id: chat }).await?;

      Ok(())
    })
  }
}
