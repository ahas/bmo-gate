//! The brain port (`docs/boundary-api.md`, 「bmo-brain」): the raw material a turn's reference is picked from
//! and the facts the gate hands back, in the brain's conventions — camelCase bodies, every call a `POST`, and a
//! refusal answered as an answer.

use std::collections::BTreeMap;

use futures_util::future::BoxFuture;
use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

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

// The brain's own members, as its generic API answers them: a fragment under the caller's scope, its old
// fields kept in `labels`, and a memory row with its conditions and labels. The brain gives none of them a
// meaning; the gate maps them to what its reference road reads.

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrainFragment {
  #[serde(default)]
  key: String,
  #[serde(default)]
  kind: String,
  #[serde(default)]
  scope: Option<String>,
  #[serde(default)]
  subject_key: Option<String>,
  #[serde(default)]
  title: Option<String>,
  #[serde(default)]
  path: Option<String>,
  #[serde(default)]
  text: Option<String>,
  #[serde(default)]
  version: Option<String>,
  #[serde(default)]
  labels: BTreeMap<String, String>,
  #[serde(default)]
  hit_count: i64,
  #[serde(default)]
  last_hit_at: Option<i64>,
  #[serde(default)]
  created_at: i64,
  #[serde(default)]
  changed_at: i64,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrainMemory {
  #[serde(default)]
  id: i64,
  #[serde(default)]
  scope: String,
  #[serde(default)]
  subject_key: Option<String>,
  #[serde(default)]
  kind: String,
  #[serde(default)]
  text: String,
  #[serde(default)]
  state: String,
  #[serde(default)]
  conditions: Vec<BTreeMap<String, Value>>,
  #[serde(default)]
  labels: BTreeMap<String, String>,
  #[serde(default)]
  match_count: i64,
  #[serde(default)]
  last_matched_at: Option<i64>,
  #[serde(default)]
  created_at: i64,
  #[serde(default)]
  changed_at: i64,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct Knowledge {
  #[serde(default)]
  fragments: Vec<BrainFragment>,
  #[serde(default)]
  memories: Vec<BrainMemory>,
}

#[derive(Deserialize)]
struct Page<T> {
  #[serde(default)]
  items: Vec<T>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FragmentHits<'a> {
  keys: Vec<String>,
  actor_name: &'a str,
  scope: String,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct Recorded {
  #[serde(default)]
  recorded_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryMatches<'a> {
  memory_ids: Vec<i64>,
  actor_name: &'a str,
  spent_ms: i64,
  token_count: i64,
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

// The scopes a turn's agent reads in a room: its own scope, and the room's beside it. The names are the
// deployment's convention, the brain's own only as strings.
fn scopes_of(agent: &str, chat: i64) -> String {
  format!("{agent},{agent}:room:{chat}")
}

fn room_scope(agent: &str, chat: i64) -> String {
  format!("{agent}:room:{chat}")
}

// The brain's kind for one of the gate's reference kinds. The person-book chunks are the brain's `person`
// kind, and the shipped documents and lore are held nowhere in the brain, so those are offered no rows.
fn brain_kind(kind: &str) -> Option<&'static str> {
  match kind {
    "person-book" => Some("person"),
    "library-knowledge" | "knowledge" => Some("library-knowledge"),
    "room-rule" => Some("room-rule"),
    _ => None,
  }
}

fn label(labels: &BTreeMap<String, String>, key: &str) -> Option<String> {
  labels.get(key).filter(|value| !value.is_empty()).cloned()
}

fn label_i64(labels: &BTreeMap<String, String>, key: &str) -> Option<i64> {
  label(labels, key).and_then(|value| value.parse().ok())
}

fn label_json<T: DeserializeOwned>(labels: &BTreeMap<String, String>, key: &str) -> Option<T> {
  label(labels, key).and_then(|value| serde_json::from_str(&value).ok())
}

fn event_of(said: &str) -> Option<Event> {
  if said.is_empty() {
    return None;
  }

  Some(match said.split_once(':') {
    Some((kind, item)) => Event {
      kind: kind.to_owned(),
      item: item.parse().ok(),
    },
    None => Event {
      kind: said.to_owned(),
      item: None,
    },
  })
}

fn chat_of(scope: Option<&str>, labels: &BTreeMap<String, String>) -> Option<i64> {
  label_i64(labels, "chat_id")
    .or_else(|| scope.and_then(|scope| scope.rsplit_once(":room:").and_then(|(_, chat)| chat.parse().ok())))
}

fn slug_of(row: &BrainFragment) -> String {
  label(&row.labels, "slug")
    .or_else(|| row.key.rsplit(':').next().map(str::to_owned))
    .unwrap_or_else(|| row.key.clone())
}

fn fragment_row(agent: &str, row: BrainFragment) -> Fragment {
  let slug = slug_of(&row);
  let chat = chat_of(row.scope.as_deref(), &row.labels);
  let labels = &row.labels;

  Fragment {
    key: row.key,
    kind: label(labels, "kind").unwrap_or_else(|| row.kind.clone()),
    chat_id: chat,
    owner: label_i64(labels, "owner"),
    agent: label(labels, "agent").unwrap_or_else(|| agent.to_owned()),
    all_agents: label(labels, "all_agents")
      .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true")),
    slug,
    title: row.title.unwrap_or_default(),
    path: row.path.unwrap_or_default(),
    scope: row.scope,
    position: label_i64(labels, "position").unwrap_or(0),
    active: true,
    last_hit_at: row.last_hit_at,
    hits: row.hit_count,
    set_by: label_i64(labels, "set_by"),
    set_at: label_i64(labels, "set_at").unwrap_or(row.created_at),
    hand: None,
    hand_at: None,
    keywords: label_json(labels, "keywords").unwrap_or_default(),
    items: label_json(labels, "items").unwrap_or_default(),
    written_on: label(labels, "written_on"),
    confirmed_on: label(labels, "confirmed_on"),
    status: label(labels, "status").unwrap_or_default(),
    body_hash: row.version,
  }
}

fn memory_row(agent: &str, row: BrainMemory) -> MemoryRow {
  let labels = &row.labels;
  let first = row.conditions.first();
  let condition = first
    .and_then(|one| one.get("condition"))
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_owned();
  let action = first
    .and_then(|one| one.get("action"))
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_owned();
  let event = label(labels, "event")
    .or_else(|| first.and_then(|one| one.get("event")).and_then(Value::as_str).map(str::to_owned));

  MemoryRow {
    id: row.id,
    agent: label(labels, "agent").unwrap_or_else(|| agent.to_owned()),
    slug: label(labels, "slug").unwrap_or_else(|| format!("memory-{}", row.id)),
    kind: row.kind,
    chat_id: label_i64(labels, "chat_id"),
    reach: label(labels, "reach").unwrap_or_default(),
    condition,
    action,
    for_user: label_i64(labels, "for_user"),
    message_id: label_i64(labels, "message_id"),
    todo_id: label_i64(labels, "todo_id"),
    set_by: label_i64(labels, "set_by"),
    set_at: label_i64(labels, "set_at").unwrap_or(row.created_at),
    active: row.state == "standing",
    last_hit_at: row.last_matched_at,
    hits: row.match_count,
    done_at: label_i64(labels, "done_at"),
    done_text: label(labels, "done_text"),
    down_reason: label(labels, "down_reason"),
    down_at: label_i64(labels, "down_at"),
    candidate_why: label(labels, "candidate_why"),
    candidate_at: label_i64(labels, "candidate_at"),
    event: event.as_deref().and_then(event_of),
    event_met_at: label_i64(labels, "event_met_at"),
    moved_at: label_i64(labels, "moved_at"),
  }
}

fn conditions_of(rows: &[BrainMemory]) -> Vec<Condition> {
  let mut found = Vec::new();

  for row in rows {
    let slug = label(&row.labels, "slug").unwrap_or_else(|| format!("memory-{}", row.id));

    for one in &row.conditions {
      let condition = one.get("condition").and_then(Value::as_str).unwrap_or_default();
      let event = one.get("event").and_then(Value::as_str).unwrap_or_default();
      let said = if condition.is_empty() { event } else { condition };

      if said.is_empty() {
        continue;
      }

      found.push(Condition {
        slug: slug.clone(),
        condition: said.to_owned(),
        action: one.get("action").and_then(Value::as_str).unwrap_or_default().to_owned(),
      });
    }
  }

  found
}

fn woken_of(agent: &str, rows: Vec<BrainMemory>, events: &[Event]) -> Vec<MemoryRow> {
  let wanted: Vec<String> = events
    .iter()
    .map(|event| match event.item {
      Some(item) => format!("{}:{}", event.kind, item),
      None => event.kind.clone(),
    })
    .collect();

  rows
    .into_iter()
    .filter(|row| {
      label(&row.labels, "event").is_some_and(|said| wanted.iter().any(|one| one == &said))
        || row.conditions.iter().any(|one| {
          let said = one.get("event").and_then(Value::as_str).unwrap_or_default();

          !said.is_empty() && wanted.iter().any(|one| one == said)
        })
    })
    .map(|row| memory_row(agent, row))
    .collect()
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

  async fn get<T: DeserializeOwned>(
    &self,
    call: &'static str,
    path: &str,
    query: &[(&str, &str)],
  ) -> Answer<T> {
    let segments: Vec<&str> = path.split('/').collect();

    self.caller.get(call, &segments, query).await
  }

  // The standing rows of the agent's own scope and of the room's, read in pages of the size the route
  // takes, each after the last id read, so a scope holding more than one page is read whole rather than
  // cut or refused.
  async fn memories(&self, agent: &str, chat: i64) -> Answer<Vec<BrainMemory>> {
    let mut all: Vec<BrainMemory> = Vec::new();
    let limit = PAGE_ROWS.to_string();

    for scope in [agent.to_owned(), room_scope(agent, chat)] {
      let mut after: Option<i64> = None;

      loop {
        let after_text = after.map(|id| id.to_string());
        let mut query: Vec<(&str, &str)> =
          vec![("scope", scope.as_str()), ("state", "standing"), ("limit", &limit)];

        if let Some(after) = after_text.as_deref() {
          query.push(("after", after));
        }

        let page: Page<BrainMemory> = self.get("standing rows", "memories", &query).await?;
        let full = page.items.len() >= PAGE_ROWS;
        let last = page.items.last().map(|row| row.id);

        all.extend(page.items);

        match (full, last) {
          (true, Some(id)) => after = Some(id),
          _ => break,
        }
      }
    }

    Ok(all)
  }
}

impl Brain for HttpBrain {
  fn standing<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      let rows = self.memories(agent, chat).await?;

      Ok(rows.into_iter().map(|row| memory_row(agent, row)).collect())
    })
  }

  fn conditions<'a>(&'a self, agent: &'a str, chat: i64) -> BoxFuture<'a, Answer<Vec<Condition>>> {
    Box::pin(async move {
      let rows = self.memories(agent, chat).await?;

      Ok(conditions_of(&rows))
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
      let rows = self.memories(agent, chat).await?;
      let mut ids: Vec<i64> = rows
        .iter()
        .filter(|row| {
          let slug = label(&row.labels, "slug").unwrap_or_else(|| format!("memory-{}", row.id));

          matched.iter().any(|one| one == &slug)
        })
        .map(|row| row.id)
        .collect();
      ids.sort_unstable();
      ids.dedup();

      if ids.is_empty() {
        return Ok(());
      }

      let _: Recorded = self
        .post(
          "matched rows",
          "memory-matches",
          &MemoryMatches {
            memory_ids: ids,
            actor_name: agent,
            spent_ms: 0,
            token_count: 0,
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
      let rows = self.memories(agent, chat).await?;

      Ok(woken_of(agent, rows, events))
    })
  }

  fn offered<'a>(
    &'a self,
    agent: &'a str,
    chat: i64,
    kinds: &'a [String],
  ) -> BoxFuture<'a, Answer<Vec<Fragment>>> {
    Box::pin(async move {
      let mut wanted: Vec<&str> = Vec::new();

      for kind in kinds {
        let Some(brain) = brain_kind(kind) else { continue };

        if !wanted.contains(&brain) {
          wanted.push(brain);
        }
      }

      if wanted.is_empty() {
        return Ok(Vec::new());
      }

      let scopes = scopes_of(agent, chat);
      let wanted = wanted.join(",");
      let knowledge: Knowledge = self
        .get(
          "fragments offered",
          "knowledge",
          &[("scopes", scopes.as_str()), ("kinds", wanted.as_str())],
        )
        .await?;

      Ok(knowledge.into_iter_map(agent))
    })
  }

  fn hits<'a>(&'a self, agent: &'a str, chat: i64, attached: &'a [Hit]) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      let keys: Vec<String> =
        attached.iter().map(|hit| hit.key.clone()).filter(|key| !key.is_empty()).collect();

      if keys.is_empty() {
        return Ok(());
      }

      let _: Recorded = self
        .post(
          "fragments attached",
          "fragment-hits",
          &FragmentHits {
            keys,
            actor_name: agent,
            scope: room_scope(agent, chat),
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
      let scopes = scopes_of(agent, chat);
      let knowledge: Knowledge = self
        .get(
          "knowledge read",
          "knowledge",
          &[("scopes", scopes.as_str()), ("kinds", "library-knowledge")],
        )
        .await?;
      let documents = knowledge
        .fragments
        .into_iter()
        .filter(|row| slugs.iter().any(|one| one == &slug_of(row)))
        .map(|row| Document {
          slug: slug_of(&row),
          path: row.path.unwrap_or_default(),
          text: row.text.unwrap_or_default(),
          version: row.version.unwrap_or_default(),
        })
        .collect();

      Ok(Reply::Answered(documents))
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
      let scopes = scopes_of(agent, chat);
      let mut sheets: Vec<Sheet> = Vec::new();
      let mut pieces: Vec<PeoplePiece> = Vec::new();

      for sender in senders {
        let ask = sender.to_string();
        let knowledge: Knowledge = self
          .get(
            "person sheets read",
            "knowledge",
            &[("scopes", scopes.as_str()), ("kinds", "person"), ("subjectKey", ask.as_str())],
          )
          .await?;

        for row in knowledge.fragments {
          if label(&row.labels, "kind").is_some_and(|kind| kind == "person-book") {
            pieces.push(piece_of(&row));
          } else {
            sheets.push(Sheet {
              person: *sender,
              part: label(&row.labels, "part").unwrap_or_default(),
              path: row.path.unwrap_or_default(),
              text: row.text.unwrap_or_default(),
              version: row.version.unwrap_or_default(),
            });
          }
        }
      }

      if !slugs.is_empty() {
        let knowledge: Knowledge = self
          .get("person pieces read", "knowledge", &[("scopes", scopes.as_str()), ("kinds", "person")])
          .await?;

        for row in knowledge.fragments {
          if !slugs.iter().any(|one| one == &slug_of(&row)) {
            continue;
          }

          if label(&row.labels, "kind").is_some_and(|kind| kind == "person-book") {
            pieces.push(piece_of(&row));
          } else {
            let slug = slug_of(&row);

            pieces.push(PeoplePiece {
              slug,
              path: row.path.unwrap_or_default(),
              text: row.text.unwrap_or_default(),
              version: row.version.unwrap_or_default(),
              owner: label_i64(&row.labels, "owner"),
            });
          }
        }
      }

      Ok(Reply::Answered(People { sheets, pieces }))
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

fn piece_of(row: &BrainFragment) -> PeoplePiece {
  PeoplePiece {
    slug: slug_of(row),
    path: row.path.clone().unwrap_or_default(),
    text: row.text.clone().unwrap_or_default(),
    version: row.version.clone().unwrap_or_default(),
    owner: label_i64(&row.labels, "owner"),
  }
}

impl Knowledge {
  fn into_iter_map(self, agent: &str) -> Vec<Fragment> {
    self.fragments.into_iter().map(|row| fragment_row(agent, row)).collect()
  }
}
