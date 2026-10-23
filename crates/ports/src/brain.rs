//! The brain port (`docs/boundary-api.md`, 「bmo-brain」): the raw material a turn's reference is picked from
//! and the facts the gate hands back, in the brain's conventions — camelCase bodies, every call a `POST`, and a
//! refusal answered as an answer.

use std::collections::BTreeMap;

use futures_util::future::BoxFuture;
use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::brain_rows::{
  BrainMember, FACT_TYPE, LORE_TYPE, Layer, Memory, Page, STANDING_TYPES, Subject, Tally, brain_type,
  conditions, fragment_row, in_room, label, lore_rows, lore_slug, memory_row, path_of, person_row,
  sheet_path, slug_of, standing, woken_by,
};
use crate::http::{Answer, Caller, Peer};

/// The rows one page of the brain's memories may hold, which is the ceiling its route takes.
const PAGE_ROWS: usize = 500;

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
  /// The brain's own key for the row, which a hit names it by.
  pub key: String,
  pub kind: String,
  pub chat_id: Option<i64>,
  pub owner: Option<i64>,
  pub agent: String,
  pub all_agents: bool,
  pub slug: String,
  pub title: String,
  pub path: String,
  pub scope: Option<String>,
  /// The heading of the brain's table of contents the row stands under, where its library has headings.
  #[serde(default)]
  pub section: Option<String>,
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
  /// The brain's own key for the row.
  pub key: String,
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

/// One person's sheet in a room, as the brain renders it from the facts about them: the person, the path it is
/// handed under and its lines.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sheet {
  pub person: i64,
  pub path: String,
  pub text: String,
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

  /// The lore pieces asked for, by their slugs.
  fn lore<'a>(&'a self, agent: &'a str, slugs: &'a [String]) -> BoxFuture<'a, Answer<Vec<Document>>>;

  /// Each of these people's sheets in the room, in the order asked: what the brain renders from their facts
  /// about no room and their facts about the room, its first `lines` lines alone where a count is given. A person
  /// the brain knows no fact of there has none.
  fn sheets<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    people: &'a [i64],
    lines: Option<usize>,
  ) -> BoxFuture<'a, Answer<Vec<Sheet>>>;

  /// The rules the owner grants in the room.
  fn room_rules(&self, chat: i64) -> BoxFuture<'_, Answer<Vec<RoomRule>>>;

  /// What a session already holds.
  fn loads<'a>(&'a self, session: &'a str) -> BoxFuture<'a, Answer<Vec<Load>>>;
}

// A subject as a brain finds it: the brain, the subject's type and its key.
type SubjectKey = (i64, String, String);

/// The brain over HTTP: the agent's brain found once by the agent's key, its memories read by type and
/// mapped to the reference road's rows (the brain's `docs/boundary-api.md`, 「Brains」).
#[derive(Clone, Debug)]
pub struct HttpBrain {
  caller: Caller,
  brains: std::sync::Arc<std::sync::Mutex<BTreeMap<String, i64>>>,
  subjects: std::sync::Arc<std::sync::Mutex<BTreeMap<SubjectKey, i64>>>,
}

impl HttpBrain {
  pub fn new(peer: Peer) -> Self {
    Self {
      caller: Caller::new("bmo-brain", peer),
      brains: std::sync::Arc::new(std::sync::Mutex::new(BTreeMap::new())),
      subjects: std::sync::Arc::new(std::sync::Mutex::new(BTreeMap::new())),
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hits<'a> {
  memory_ids: Vec<i64>,
  actor_name: &'a str,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct Recorded {
  #[serde(default)]
  recorded_count: i64,
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
  async fn get<T: DeserializeOwned>(
    &self,
    call: &'static str,
    path: &str,
    query: &[(&str, &str)],
  ) -> Answer<T> {
    let segments: Vec<&str> = path.split('/').collect();

    self.caller.get(call, &segments, query).await
  }

  async fn post<B: Serialize, T: DeserializeOwned>(
    &self,
    call: &'static str,
    path: &str,
    body: &B,
  ) -> Answer<T> {
    let segments: Vec<&str> = path.split('/').collect();

    self.caller.post(call, &segments, body).await
  }

  // The agent's brain, by the agent's key, remembered once found.
  async fn brain(&self, agent: &str) -> Answer<i64> {
    if let Some(id) = self.brains.lock().ok().and_then(|held| held.get(agent).copied()) {
      return Ok(id);
    }

    let page: Page<BrainMember> =
      self.get("the agent's brain", "brains", &[("agentKey", agent), ("limit", "2")]).await?;
    let found = page.items.into_iter().find(|brain| brain.agent_key == agent).map(|brain| brain.id);
    let id = found.ok_or_else(|| crate::http::PortError::Malformed {
      unit: "bmo-brain",
      call: "the agent's brain",
      status: 200,
      why: format!("the brain lists no brain of the agent {agent:?}"),
    })?;

    if let Ok(mut held) = self.brains.lock() {
      held.insert(agent.to_owned(), id);
    }

    Ok(id)
  }

  // The active memories of one type in a brain, read in pages of the size the route takes, each after the
  // last id read, so a type holding more than one page is read whole.
  async fn active(&self, brain: i64, kind: &str) -> Answer<Vec<Memory>> {
    let mut all: Vec<Memory> = Vec::new();
    let path = format!("brains/{brain}/memories");
    let limit = PAGE_ROWS.to_string();
    let mut after: Option<i64> = None;

    loop {
      let after_text = after.map(|id| id.to_string());
      let mut query: Vec<(&str, &str)> = vec![("type", kind), ("status", "active"), ("limit", &limit)];

      if let Some(after) = after_text.as_deref() {
        query.push(("after", after));
      }

      let page: Page<Memory> = self.get("memories read", &path, &query).await?;
      let last = page.items.last().map(|row| row.id);
      let more = page.more;

      all.extend(page.items);

      match (more, last) {
        (true, Some(id)) => after = Some(id),
        _ => break,
      }
    }

    Ok(all)
  }

  // A brain's layers, read in pages of the size the route takes, each after the largest id read, and set in the
  // order the brain lists them by.
  async fn layers(&self, brain: i64) -> Answer<Vec<Layer>> {
    let mut all: Vec<Layer> = Vec::new();
    let path = format!("brains/{brain}/layers");
    let limit = PAGE_ROWS.to_string();
    let mut after: Option<i64> = None;

    loop {
      let after_text = after.map(|id| id.to_string());
      let mut query: Vec<(&str, &str)> = vec![("limit", &limit)];

      if let Some(after) = after_text.as_deref() {
        query.push(("after", after));
      }

      let page: Page<Layer> = self.get("layers read", &path, &query).await?;
      let last = page.items.iter().map(|layer| layer.id).max();
      let more = page.more;

      all.extend(page.items);

      match (more, last) {
        (true, Some(id)) => after = Some(id),
        _ => break,
      }
    }

    all.sort_by_key(|layer| (layer.position, layer.id));

    Ok(all)
  }

  // The memories the standing rows and the conditions are read from: every active row of the standing
  // types read in the room.
  async fn held(&self, agent: &str, chat: i64) -> Answer<Vec<Memory>> {
    let brain = self.brain(agent).await?;
    let mut all = Vec::new();

    for kind in STANDING_TYPES {
      all.extend(self.active(brain, kind).await?.into_iter().filter(|memory| in_room(memory, chat)));
    }

    all.sort_by_key(|memory| memory.id);
    all.dedup_by_key(|memory| memory.id);

    Ok(all)
  }

  // A subject of a brain by its type and key, remembered once found; none where the brain holds none.
  async fn subject(&self, brain: i64, kind: &str, key: &str) -> Answer<Option<i64>> {
    let held = (brain, kind.to_owned(), key.to_owned());

    if let Some(id) = self.subjects.lock().ok().and_then(|subjects| subjects.get(&held).copied()) {
      return Ok(Some(id));
    }

    let page: Page<Subject> = self
      .get(
        "a subject found",
        &format!("brains/{brain}/subjects"),
        &[("type", kind), ("key", key), ("limit", "1")],
      )
      .await?;
    let found = page.items.into_iter().find(|subject| subject.kind == kind && subject.key == key);

    if let (Some(subject), Ok(mut subjects)) = (&found, self.subjects.lock()) {
      subjects.insert(held, subject.id);
    }

    Ok(found.map(|subject| subject.id))
  }

  // The people the brain's live facts are about, each as the person-book search's candidate in the room.
  async fn people_rows(&self, agent: &str, chat: i64) -> Answer<Vec<Fragment>> {
    let brain = self.brain(agent).await?;
    let tallies: Vec<Tally> = self
      .get(
        "people offered",
        &format!("brains/{brain}/tallies"),
        &[("type", FACT_TYPE), ("status", "active"), ("by", "subject")],
      )
      .await?;
    let ids: Vec<String> = tallies.into_iter().filter_map(|tally| tally.group).collect();
    let limit = PAGE_ROWS.to_string();
    let mut people: Vec<(i64, Option<String>)> = Vec::new();

    for ids in ids.chunks(PAGE_ROWS) {
      let ids = ids.join(",");
      let page: Page<Subject> = self
        .get("people named", &format!("brains/{brain}/subjects"), &[("ids", &ids), ("limit", &limit)])
        .await?;

      people.extend(
        page
          .items
          .into_iter()
          .filter(|subject| subject.kind == "person")
          .filter_map(|subject| subject.key.parse().ok().map(|person| (person, subject.name))),
      );
    }

    people.sort_by_key(|(person, _)| *person);
    people.dedup_by_key(|(person, _)| *person);

    Ok(
      people
        .iter()
        .map(|(person, name)| person_row(agent, chat, *person, name.as_deref()))
        .collect(),
    )
  }

  // The active rows of a reference kind read in the room, as the gate's fragment rows.
  async fn rows_of(&self, agent: &str, chat: i64, kind: &str) -> Answer<Vec<Fragment>> {
    let Some((brain_type, old_kind)) = brain_type(kind) else {
      return Ok(Vec::new());
    };

    if brain_type == FACT_TYPE {
      return self.people_rows(agent, chat).await;
    }

    let brain = self.brain(agent).await?;
    let rows = self.active(brain, brain_type).await?;

    if brain_type == LORE_TYPE {
      let layers = self.layers(brain).await?;
      let read: Vec<Memory> = rows.into_iter().filter(|memory| in_room(memory, chat)).collect();

      return Ok(lore_rows(agent, &read, &layers));
    }

    Ok(
      rows
        .iter()
        .filter(|memory| in_room(memory, chat))
        .map(|memory| fragment_row(agent, old_kind, memory))
        .collect(),
    )
  }

  async fn hit(&self, agent: &str, ids: Vec<i64>) -> Answer<()> {
    if ids.is_empty() {
      return Ok(());
    }

    let brain = self.brain(agent).await?;
    let _: Recorded = self
      .post(
        "memories attached",
        &format!("brains/{brain}/hits"),
        &Hits {
          memory_ids: ids,
          actor_name: agent,
        },
      )
      .await?;

    Ok(())
  }
}

impl Brain for HttpBrain {
  fn standing<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      let rows = self.held(agent, chat).await?;

      Ok(
        rows
          .iter()
          .filter(|memory| standing(memory))
          .map(|memory| memory_row(agent, memory))
          .collect(),
      )
    })
  }

  fn conditions<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Vec<Condition>>> {
    Box::pin(async move {
      let rows = self.held(agent, chat).await?;

      Ok(conditions(&rows))
    })
  }

  fn matched<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    matched: &'a [String],
    _spent: &'a [String],
  ) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      let rows = self.held(agent, chat).await?;
      let mut ids: Vec<i64> = rows
        .iter()
        .filter(|memory| {
          let slug = slug_of(memory);

          matched.iter().any(|one| one == &slug)
        })
        .map(|memory| memory.id)
        .collect();
      ids.sort_unstable();
      ids.dedup();

      self.hit(agent, ids).await
    })
  }

  fn woken<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    events: &'a [Event],
  ) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      let rows = self.held(agent, chat).await?;

      Ok(
        rows
          .iter()
          .filter(|memory| woken_by(memory, events))
          .map(|memory| memory_row(agent, memory))
          .collect(),
      )
    })
  }

  fn offered<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    kinds: &'a [String],
  ) -> BoxFuture<'a, Answer<Vec<Fragment>>> {
    Box::pin(async move {
      let mut all: Vec<Fragment> = Vec::new();
      let mut read: Vec<&str> = Vec::new();

      for kind in kinds {
        let Some((brain_type, _)) = brain_type(kind) else { continue };

        if read.contains(&brain_type) {
          continue;
        }

        read.push(brain_type);
        all.extend(self.rows_of(agent, chat, kind).await?);
      }

      Ok(all)
    })
  }

  fn hits<'a>(&'a self, agent: &'a str, _chat: i64, attached: &'a [Hit]) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      let mut ids: Vec<i64> = attached.iter().filter_map(|hit| hit.key.parse().ok()).collect();
      ids.sort_unstable();
      ids.dedup();

      self.hit(agent, ids).await
    })
  }

  fn knowledge<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<Vec<Document>>>> {
    Box::pin(async move {
      let brain = self.brain(agent).await?;
      let rows = self.active(brain, "knowledge").await?;
      let documents = rows
        .iter()
        .filter(|memory| in_room(memory, chat) && slugs.iter().any(|one| one == &slug_of(memory)))
        .map(|memory| Document {
          slug: slug_of(memory),
          path: label(&memory.labels, "path").unwrap_or_else(|| format!("memories/{}", memory.id)),
          text: memory.text.clone(),
          version: memory.id.to_string(),
        })
        .collect();

      Ok(Reply::Answered(documents))
    })
  }

  fn lore<'a>(&'a self, agent: &'a str, slugs: &'a [String]) -> BoxFuture<'a, Answer<Vec<Document>>> {
    Box::pin(async move {
      let brain = self.brain(agent).await?;
      let rows = self.active(brain, LORE_TYPE).await?;

      Ok(
        rows
          .iter()
          .filter(|memory| slugs.iter().any(|one| one == &lore_slug(memory)))
          .map(|memory| Document {
            slug: lore_slug(memory),
            path: path_of(memory),
            text: memory.text.clone(),
            version: memory.id.to_string(),
          })
          .collect(),
      )
    })
  }

  fn sheets<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    people: &'a [i64],
    lines: Option<usize>,
  ) -> BoxFuture<'a, Answer<Vec<Sheet>>> {
    Box::pin(async move {
      if people.is_empty() {
        return Ok(Vec::new());
      }

      let brain = self.brain(agent).await?;
      let room = self.subject(brain, "room", &chat.to_string()).await?.map(|room| room.to_string());
      let limit = lines.map(|lines| lines.to_string());
      let query: Vec<(&str, &str)> = [("roomId", room.as_deref()), ("limit", limit.as_deref())]
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect();
      let mut sheets: Vec<Sheet> = Vec::new();

      for &person in people {
        let Some(subject) = self.subject(brain, "person", &person.to_string()).await? else {
          continue;
        };
        let path = format!("brains/{brain}/subjects/{subject}/sheet");
        let segments: Vec<&str> = path.split('/').collect();
        let text = self.caller.get_text("a person's sheet", &segments, &query).await?;

        if text.trim().is_empty() {
          continue;
        }

        sheets.push(Sheet {
          person,
          path: sheet_path(chat, person),
          text,
        });
      }

      Ok(sheets)
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
