//! The brain port (`docs/boundary-api.md`, 「bmo-brain」): the raw material a turn's reference is picked from
//! and the facts the gate hands back, in the brain's conventions — camelCase bodies, every call a `POST`, and a
//! refusal answered as an answer.

use std::collections::BTreeMap;

use futures_util::future::BoxFuture;
use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::PortError;
use crate::audience::Audience;
use crate::brain_rows::{
  BrainMember, FACT_TYPE, LORE_TYPE, Layer, Memory, Page, STANDING_TYPES, Subject, Tally, TopicItem,
  brain_type, conditions, fragment_row, held_row, in_room, label, lore_rows, lore_slug, memory_row, org_memory,
  path_of, person_row, sheet_path, slug_of, standing, woken_by,
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
  pub down_at: Option<i64>,
  pub candidate_why: Option<String>,
  pub candidate_at: Option<i64>,
  pub event: Option<Event>,
  pub event_met_at: Option<i64>,
  pub moved_at: Option<i64>,
}

/// One row a holder left in an agent's brain and that stands there now: the brain's number, the holder's key, the
/// key the holder gave the row, and its words (the brain's `docs/design.md`, 「What a holder leaves」).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldRow {
  pub id: i64,
  pub holder: String,
  pub key: Option<String>,
  pub text: String,
}

/// A row with a condition, as the brain's index lists it among the room's rules.
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

/// One document a session holds, by its path and version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Load {
  pub path: String,
  pub version: String,
}

/// One live memory of an org brain: its number, its words, its importance, whether it is locked, whether it is
/// kept from a room where someone outside the company sits, its recall condition, the topics it stands for and when
/// it last changed (the brain's `docs/design.md`, 「Org brains」).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrgMemory {
  pub id: i64,
  pub text: String,
  pub importance: i64,
  pub locked: bool,
  pub internal_only: bool,
  pub recall_condition: Option<String>,
  pub topics: Vec<String>,
  pub changed_at: i64,
  /// The brain a memory of the base was raised from, as its `sourceBrainId` label names it; none for any other.
  pub source_brain: Option<i64>,
}

/// One topic as it stands for a member of an organisation: the org brain whose word on it holds, whether that word is
/// locked, and its memories, the most important first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrgTopic {
  pub topic: String,
  pub brain: i64,
  pub locked: bool,
  pub memories: Vec<OrgMemory>,
}

/// Whose brain a read is of: the agent's key and the key of the account its brain is filed under, none for an agent
/// of no account (the brain's `docs/design.md`, 「Whose a brain is」; `docs/reference-selection.md`, 「Whose reference
/// it is」).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BrainKey {
  pub account: Option<String>,
  pub agent: String,
}

impl BrainKey {
  /// The brain of an agent no account owns: the one brain filed under its key in any account.
  pub fn unowned(agent: impl Into<String>) -> Self {
    Self {
      account: None,
      agent: agent.into(),
    }
  }

  /// The brain of an agent an account owns, filed under the owning user's id.
  pub fn owned(agent: impl Into<String>, user: i64) -> Self {
    Self {
      account: Some(user.to_string()),
      agent: agent.into(),
    }
  }

  /// The user whose account the brain is filed under, none for an agent of no account.
  pub fn owner(&self) -> Option<i64> {
    self.account.as_deref().and_then(|account| account.parse().ok())
  }
}

/// Every call the gate makes on the brain, each of one agent's brain alone; an agent keeping no brain is answered
/// nothing.
pub trait Brain: Send + Sync {
  /// Whether the agent keeps a brain: none where the brain lists no brain of the key, and none where an agent of no
  /// account has its key on brains of more than one account.
  fn kept<'a>(&'a self, key: &'a BrainKey) -> BoxFuture<'a, Answer<bool>>;

  /// The agent's own brain, none where it keeps none.
  fn own<'a>(&'a self, key: &'a BrainKey) -> BoxFuture<'a, Answer<Option<i64>>>;

  /// The platform's base, the org brain keyed by the platform (the brain's `docs/design.md`, 「The base」); none
  /// where the brain keeps none.
  fn base(&self) -> BoxFuture<'_, Answer<Option<i64>>>;

  /// The room's open rows that wait on nothing, and the errands whose event has come.
  fn standing<'a>(&'a self, key: &'a BrainKey, chat: i64) -> BoxFuture<'a, Answer<Vec<MemoryRow>>>;

  /// The rows with a condition that reach the room.
  fn conditions<'a>(&'a self, key: &'a BrainKey, chat: i64) -> BoxFuture<'a, Answer<Vec<Condition>>>;

  /// The rows the turn's events wake.
  fn woken<'a>(
    &'a self,
    key: &'a BrainKey,
    chat: i64,
    events: &'a [Event],
  ) -> BoxFuture<'a, Answer<Vec<MemoryRow>>>;

  /// The rows a holder left in the agent's brain that stand there now, as the brain lists them; none where the
  /// agent keeps no brain (the brain's `docs/design.md`, 「What a holder leaves」).
  fn held_rows<'a>(&'a self, key: &'a BrainKey) -> BoxFuture<'a, Answer<Vec<HeldRow>>>;

  /// The active fragment rows of the kinds named the turn's agent may be offered in the room.
  fn offered<'a>(
    &'a self,
    key: &'a BrainKey,
    chat: i64,
    kinds: &'a [String],
  ) -> BoxFuture<'a, Answer<Vec<Fragment>>>;

  /// The knowledge chunks asked for, in the order asked, or the brain's refusal of a slug outside the room.
  fn knowledge<'a>(
    &'a self,
    key: &'a BrainKey,
    chat: i64,
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<Vec<Document>>>>;

  /// The lore pieces asked for, by their slugs.
  fn lore<'a>(&'a self, key: &'a BrainKey, slugs: &'a [String]) -> BoxFuture<'a, Answer<Vec<Document>>>;

  /// Each of these people's sheets in the room, in the order asked: what the brain renders from their facts
  /// about no room and their facts about the room, its first `lines` lines alone where a count is given. A person
  /// the brain knows no fact of there has none.
  fn sheets<'a>(
    &'a self,
    key: &'a BrainKey,
    chat: i64,
    people: &'a [i64],
    lines: Option<usize>,
  ) -> BoxFuture<'a, Answer<Vec<Sheet>>>;

  /// The org brain of a unit of a company, by their numbers; none where the brain keeps none.
  fn org_brain(&self, company: i64, unit: i64) -> BoxFuture<'_, Answer<Option<i64>>>;

  /// What stands for a member of the units whose org brains are named, the farthest first: for each topic, the
  /// memories of the one brain whose word on it holds, read for the audience named.
  fn org_topics<'a>(
    &'a self,
    brains: &'a [i64],
    audience: Audience,
  ) -> BoxFuture<'a, Answer<Vec<OrgTopic>>>;

  /// Every live memory of an org brain that is neither a proposal nor an episode, in the brain's order.
  fn org_memories(&self, brain: i64) -> BoxFuture<'_, Answer<Vec<OrgMemory>>>;
}

// A subject as a brain finds it: the brain, the subject's type and its key.
type SubjectKey = (i64, String, String);

/// The brain over HTTP: the agent's brain found by its account and its key and remembered once found, its
/// memories read by type and mapped to the reference road's rows (the brain's `docs/boundary-api.md`, 「Brains」).
#[derive(Clone, Debug)]
pub struct HttpBrain {
  caller: Caller,
  brains: std::sync::Arc<std::sync::Mutex<BTreeMap<BrainKey, i64>>>,
  org_brains: std::sync::Arc<std::sync::Mutex<BTreeMap<(i64, i64), i64>>>,
  base: std::sync::Arc<std::sync::Mutex<Option<i64>>>,
  subjects: std::sync::Arc<std::sync::Mutex<BTreeMap<SubjectKey, i64>>>,
}

/// The account key and the agent key the base is filed under.
pub const BASE_KEY: &str = "platform";

impl HttpBrain {
  /// A read of org brains as it came back, every org brain remembered let go where the brain answers that one it
  /// was asked of does not stand, so a unit whose org brain was removed and made again is found afresh.
  fn forgetting_gone<T>(&self, read: Answer<T>) -> Answer<T> {
    if matches!(read, Err(PortError::Refused { status: 404, .. })) {
      if let Ok(mut held) = self.org_brains.lock() {
        held.clear();
      }
      if let Ok(mut held) = self.base.lock() {
        *held = None;
      }
    }

    read
  }

  pub fn new(peer: Peer) -> Self {
    Self {
      caller: Caller::new("bmo-brain", peer),
      brains: std::sync::Arc::new(std::sync::Mutex::new(BTreeMap::new())),
      org_brains: std::sync::Arc::new(std::sync::Mutex::new(BTreeMap::new())),
      base: std::sync::Arc::new(std::sync::Mutex::new(None)),
      subjects: std::sync::Arc::new(std::sync::Mutex::new(BTreeMap::new())),
    }
  }
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

  // The agent's brain, remembered once found: the brain of its account and its key, or, for an agent of no
  // account, the one brain of its key; none where the brain lists none, or more than one for an agent of no
  // account.
  async fn brain(&self, key: &BrainKey) -> Answer<Option<i64>> {
    if let Some(id) = self.brains.lock().ok().and_then(|held| held.get(key).copied()) {
      return Ok(Some(id));
    }

    let mut query: Vec<(&str, &str)> =
      vec![("kind", "agent"), ("agentKey", key.agent.as_str()), ("limit", "2")];

    if let Some(account) = key.account.as_deref() {
      query.push(("accountKey", account));
    }

    let page: Page<BrainMember> = self.get("the agent's brain", "brains", &query).await?;
    let found: Vec<i64> = page
      .items
      .iter()
      .filter(|brain| brain.agent_key == key.agent)
      .filter(|brain| key.account.as_ref().is_none_or(|account| &brain.account_key == account))
      .map(|brain| brain.id)
      .collect();
    let alone = found.len() == 1 && (key.account.is_some() || !page.more);
    let Some(id) = found.first().copied().filter(|_| alone) else {
      return Ok(None);
    };

    if let Ok(mut held) = self.brains.lock() {
      held.insert(key.clone(), id);
    }

    Ok(Some(id))
  }

  // The active memories of one type in a brain, read whole.
  async fn active(&self, brain: i64, kind: &str) -> Answer<Vec<Memory>> {
    self.memories(brain, &[("type", kind)]).await
  }

  // The active memories of a brain the filters name, read in pages of the size the route takes, each after the
  // last id read, so a read holding more than one page is read whole.
  async fn memories(&self, brain: i64, filters: &[(&str, &str)]) -> Answer<Vec<Memory>> {
    let mut all: Vec<Memory> = Vec::new();
    let path = format!("brains/{brain}/memories");
    let limit = PAGE_ROWS.to_string();
    let mut after: Option<i64> = None;

    loop {
      let after_text = after.map(|id| id.to_string());
      let mut query: Vec<(&str, &str)> = filters.to_vec();

      query.extend([("status", "active"), ("limit", limit.as_str())]);

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
  async fn held(&self, key: &BrainKey, chat: i64) -> Answer<Vec<Memory>> {
    let Some(brain) = self.brain(key).await? else {
      return Ok(Vec::new());
    };
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
  async fn people_rows(&self, key: &BrainKey, chat: i64) -> Answer<Vec<Fragment>> {
    let Some(brain) = self.brain(key).await? else {
      return Ok(Vec::new());
    };
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
        .map(|(person, name)| person_row(&key.agent, chat, *person, name.as_deref()))
        .collect(),
    )
  }

  // The active rows of a reference kind read in the room, as the gate's fragment rows.
  async fn rows_of(&self, key: &BrainKey, chat: i64, kind: &str) -> Answer<Vec<Fragment>> {
    let Some((brain_type, old_kind)) = brain_type(kind) else {
      return Ok(Vec::new());
    };

    if brain_type == FACT_TYPE {
      return self.people_rows(key, chat).await;
    }

    let Some(brain) = self.brain(key).await? else {
      return Ok(Vec::new());
    };
    let rows = self.active(brain, brain_type).await?;

    if brain_type == LORE_TYPE {
      let layers = self.layers(brain).await?;
      let read: Vec<Memory> = rows.into_iter().filter(|memory| in_room(memory, chat)).collect();

      return Ok(lore_rows(&key.agent, &read, &layers));
    }

    Ok(
      rows
        .iter()
        .filter(|memory| in_room(memory, chat))
        .map(|memory| fragment_row(&key.agent, old_kind, memory))
        .collect(),
    )
  }
}

impl Brain for HttpBrain {
  fn kept<'a>(&'a self, key: &'a BrainKey) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move { Ok(self.brain(key).await?.is_some()) })
  }

  fn own<'a>(&'a self, key: &'a BrainKey) -> BoxFuture<'a, Answer<Option<i64>>> {
    Box::pin(async move { self.brain(key).await })
  }

  fn base(&self) -> BoxFuture<'_, Answer<Option<i64>>> {
    Box::pin(async move {
      if let Some(id) = self.base.lock().ok().and_then(|held| *held) {
        return Ok(Some(id));
      }

      let page: Page<BrainMember> = self
        .get(
          "the base",
          "brains",
          &[("kind", "org"), ("accountKey", BASE_KEY), ("agentKey", BASE_KEY), ("limit", "1")],
        )
        .await?;
      let Some(id) = page
        .items
        .iter()
        .find(|brain| brain.account_key == BASE_KEY && brain.agent_key == BASE_KEY)
        .map(|brain| brain.id)
      else {
        return Ok(None);
      };

      if let Ok(mut held) = self.base.lock() {
        *held = Some(id);
      }

      Ok(Some(id))
    })
  }

  fn standing<'a>(&'a self, key: &'a BrainKey, chat: i64) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      let rows = self.held(key, chat).await?;

      Ok(
        rows
          .iter()
          .filter(|memory| standing(memory))
          .map(|memory| memory_row(&key.agent, memory))
          .collect(),
      )
    })
  }

  fn conditions<'a>(&'a self, key: &'a BrainKey, chat: i64) -> BoxFuture<'a, Answer<Vec<Condition>>> {
    Box::pin(async move {
      let rows = self.held(key, chat).await?;

      Ok(conditions(&rows))
    })
  }

  fn woken<'a>(
    &'a self,
    key: &'a BrainKey,
    chat: i64,
    events: &'a [Event],
  ) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      let rows = self.held(key, chat).await?;

      Ok(
        rows
          .iter()
          .filter(|memory| woken_by(memory, events))
          .map(|memory| memory_row(&key.agent, memory))
          .collect(),
      )
    })
  }

  fn held_rows<'a>(&'a self, key: &'a BrainKey) -> BoxFuture<'a, Answer<Vec<HeldRow>>> {
    Box::pin(async move {
      let Some(brain) = self.brain(key).await? else {
        return Ok(Vec::new());
      };

      Ok(self.memories(brain, &[("held", "true")]).await?.iter().filter_map(held_row).collect())
    })
  }

  fn offered<'a>(
    &'a self,
    key: &'a BrainKey,
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
        all.extend(self.rows_of(key, chat, kind).await?);
      }

      Ok(all)
    })
  }

  fn knowledge<'a>(
    &'a self,
    key: &'a BrainKey,
    chat: i64,
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<Vec<Document>>>> {
    Box::pin(async move {
      let Some(brain) = self.brain(key).await? else {
        return Ok(Reply::Answered(Vec::new()));
      };
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

  fn lore<'a>(&'a self, key: &'a BrainKey, slugs: &'a [String]) -> BoxFuture<'a, Answer<Vec<Document>>> {
    Box::pin(async move {
      let Some(brain) = self.brain(key).await? else {
        return Ok(Vec::new());
      };
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
    key: &'a BrainKey,
    chat: i64,
    people: &'a [i64],
    lines: Option<usize>,
  ) -> BoxFuture<'a, Answer<Vec<Sheet>>> {
    Box::pin(async move {
      if people.is_empty() {
        return Ok(Vec::new());
      }

      let Some(brain) = self.brain(key).await? else {
        return Ok(Vec::new());
      };
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

  fn org_brain(&self, company: i64, unit: i64) -> BoxFuture<'_, Answer<Option<i64>>> {
    Box::pin(async move {
      if let Some(id) = self.org_brains.lock().ok().and_then(|held| held.get(&(company, unit)).copied()) {
        return Ok(Some(id));
      }

      let (account, agent) = (company.to_string(), unit.to_string());
      let page: Page<BrainMember> = self
        .get(
          "a unit's org brain",
          "brains",
          &[("kind", "org"), ("accountKey", &account), ("agentKey", &agent), ("limit", "1")],
        )
        .await?;
      let Some(id) = page
        .items
        .iter()
        .find(|brain| brain.account_key == account && brain.agent_key == agent)
        .map(|brain| brain.id)
      else {
        return Ok(None);
      };

      if let Ok(mut held) = self.org_brains.lock() {
        held.insert((company, unit), id);
      }

      Ok(Some(id))
    })
  }

  fn org_topics<'a>(
    &'a self,
    brains: &'a [i64],
    audience: Audience,
  ) -> BoxFuture<'a, Answer<Vec<OrgTopic>>> {
    Box::pin(async move {
      if brains.is_empty() {
        return Ok(Vec::new());
      }

      let named = brains.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
      let items: Vec<TopicItem> = self.forgetting_gone(
        self
          .get(
            "what stands for a person",
            "org-topics",
            &[("brainIds", &named), ("audience", audience.as_str())],
          )
          .await,
      )?;

      Ok(
        items
          .into_iter()
          .map(|item| OrgTopic {
            topic: item.topic,
            brain: item.brain_id,
            locked: item.locked,
            memories: item.memories.iter().map(org_memory).collect(),
          })
          .collect(),
      )
    })
  }

  fn org_memories(&self, brain: i64) -> BoxFuture<'_, Answer<Vec<OrgMemory>>> {
    Box::pin(async move {
      let rows = self.forgetting_gone(self.memories(brain, &[("excludeTypes", "rumor,episode")]).await)?;

      Ok(rows.iter().map(org_memory).collect())
    })
  }
}
