//! The brain's members and layers as its API answers them (the brain's `docs/boundary-api.md`, 「Brains」), and
//! the reading of them into what the reference road reads: a memory of the brain's new shape — a row of a type,
//! about subjects, in a version — mapped to the gate's memory rows and fragment rows, the old fields a moved
//! row kept in its `labels` read where they stand and the subjects read where they do not; and a person the
//! brain knows facts of as the person-book search's candidate.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::brain::{Condition, Event, Fragment, MemoryRow, RoomRule};

/// A brain, as the brain lists it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainMember {
  #[serde(default)]
  pub id: i64,
  #[serde(default)]
  pub agent_key: String,
}

/// A subject a memory is about.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubjectRef {
  #[serde(default)]
  pub id: i64,
  #[serde(rename = "type", default)]
  pub kind: String,
  #[serde(default)]
  pub key: String,
}

/// One memory in one version, as the brain answers it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
  #[serde(default)]
  pub id: i64,
  #[serde(default)]
  pub key: Option<String>,
  #[serde(rename = "type", default)]
  pub kind: String,
  #[serde(default)]
  pub text: String,
  #[serde(default)]
  pub layer_id: Option<i64>,
  #[serde(default)]
  pub position: i64,
  #[serde(default)]
  pub subjects: Vec<SubjectRef>,
  #[serde(default)]
  pub status: String,
  #[serde(default)]
  pub lineage_id: i64,
  #[serde(default)]
  pub valid_from: i64,
  #[serde(default)]
  pub valid_to: Option<i64>,
  #[serde(default)]
  pub importance: i64,
  #[serde(default)]
  pub hits: i64,
  #[serde(default)]
  pub last_hit_at: Option<i64>,
  #[serde(default)]
  pub labels: BTreeMap<String, String>,
  #[serde(default)]
  pub created_at: i64,
}

/// A subject as the brain lists it: a person or a room by the caller's key, and the name the brain knows it by.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
  #[serde(default)]
  pub id: i64,
  #[serde(rename = "type", default)]
  pub kind: String,
  #[serde(default)]
  pub key: String,
  #[serde(default)]
  pub name: Option<String>,
}

/// One group of a tally: a subject's id in decimal, null for the rows about no subject.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Tally {
  #[serde(default)]
  pub group: Option<String>,
}

/// A heading of the brain's table of contents: its name and where it stands among the others.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
  #[serde(default)]
  pub id: i64,
  #[serde(default)]
  pub name: String,
  #[serde(default)]
  pub position: i64,
}

/// A page of the brain's.
#[derive(Deserialize)]
pub struct Page<T> {
  #[serde(default)]
  pub items: Vec<T>,
  #[serde(default)]
  pub more: bool,
}

/// The brain's type that stands for one of the gate's reference kinds, and the fragment kind it reads back as.
/// The person book is the brain's facts, offered one person a candidate (`person_row`).
pub fn brain_type(kind: &str) -> Option<(&'static str, &'static str)> {
  match kind {
    "person-book" | "person" => Some((FACT_TYPE, PERSON_BOOK)),
    "library-knowledge" | "knowledge" => Some(("knowledge", "library-knowledge")),
    "room-rule" => Some(("rule", "room-rule")),
    "lore" => Some((LORE_TYPE, "lore")),
    _ => None,
  }
}

/// The brain's type of what is known about a person, one row a fact, which their sheet is rendered from.
pub const FACT_TYPE: &str = "fact";

/// The fragment kind of a person the person-book search is offered.
pub const PERSON_BOOK: &str = "person-book";

// What a person candidate's slug opens with before the person's number.
const PERSON_SLUG: &str = "person-";

/// The brain's type of the agent's lore, whose rows stand in the layers of its table of contents.
pub const LORE_TYPE: &str = "lore";

// What a lore row's key opens with before its slug.
const LORE_KEY: &str = "lore/";

/// The memory types the standing rows and the matcher's conditions are read from: what an agent holds of
/// its own doing in a room.
pub const STANDING_TYPES: [&str; 5] = ["promise", "check", "followup", "situation", "state"];

pub fn label(labels: &BTreeMap<String, String>, key: &str) -> Option<String> {
  labels.get(key).filter(|value| !value.is_empty()).cloned()
}

pub fn label_i64(labels: &BTreeMap<String, String>, key: &str) -> Option<i64> {
  label(labels, key).and_then(|value| value.parse().ok())
}

fn label_json<T: serde::de::DeserializeOwned>(labels: &BTreeMap<String, String>, key: &str) -> Option<T> {
  label(labels, key).and_then(|value| serde_json::from_str(&value).ok())
}

/// The room a memory is about: the old `chat_id` label, else its `room` subject.
pub fn room_of(memory: &Memory) -> Option<i64> {
  label_i64(&memory.labels, "chat_id")
    .or_else(|| memory.subjects.iter().find(|s| s.kind == "room").and_then(|s| s.key.parse().ok()))
}

/// Whether a memory is read in a room: it is about that room, or about no room at all.
pub fn in_room(memory: &Memory, chat: i64) -> bool {
  match room_of(memory) {
    Some(room) => room == chat,
    None => true,
  }
}

/// The person a memory is about: the old `owner` label, else its first `person` subject.
pub fn person_of(memory: &Memory) -> Option<i64> {
  label_i64(&memory.labels, "owner")
    .or_else(|| label_i64(&memory.labels, "for_user"))
    .or_else(|| memory.subjects.iter().find(|s| s.kind == "person").and_then(|s| s.key.parse().ok()))
}

/// The slug a gate names a memory by: the old `slug` label, else its key, else its id.
pub fn slug_of(memory: &Memory) -> String {
  label(&memory.labels, "slug")
    .or_else(|| memory.key.clone())
    .unwrap_or_else(|| format!("memory-{}", memory.id))
}

/// The slug a gate names a lore piece by: its key after `lore/`, else the slug any other row is named by.
pub fn lore_slug(memory: &Memory) -> String {
  memory
    .key
    .as_deref()
    .and_then(|key| key.strip_prefix(LORE_KEY))
    .filter(|slug| !slug.is_empty())
    .map_or_else(|| slug_of(memory), str::to_owned)
}

/// The path a piece read through the brain is handed under: the old `path` label, else the memory's own.
pub fn path_of(memory: &Memory) -> String {
  label(&memory.labels, "path").unwrap_or_else(|| format!("memories/{}", memory.id))
}

/// The old conditions a moved row kept, as objects.
fn conditions_of(memory: &Memory) -> Vec<BTreeMap<String, Value>> {
  label_json(&memory.labels, "conditions").unwrap_or_default()
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

/// A memory of the brain as the reference road's memory row.
pub fn memory_row(agent: &str, memory: &Memory) -> MemoryRow {
  let labels = &memory.labels;
  let conditions = conditions_of(memory);
  let first = conditions.first();
  let said = |name: &str| -> String {
    first
      .and_then(|one| one.get(name))
      .and_then(Value::as_str)
      .unwrap_or_default()
      .to_owned()
  };
  let (condition, action) = match (said("condition"), said("action")) {
    (condition, action) if !condition.is_empty() || !action.is_empty() => (condition, action),
    _ if memory.kind == "situation" => (memory.text.clone(), memory.text.clone()),
    _ => (String::new(), String::new()),
  };
  let event = label(labels, "event").or_else(|| Some(said("event")).filter(|e| !e.is_empty()));
  MemoryRow {
    id: memory.id,
    agent: label(labels, "agent").unwrap_or_else(|| agent.to_owned()),
    slug: slug_of(memory),
    kind: memory.kind.clone(),
    chat_id: room_of(memory),
    reach: label(labels, "reach").unwrap_or_default(),
    condition,
    action,
    for_user: person_of(memory),
    message_id: label_i64(labels, "message_id"),
    todo_id: label_i64(labels, "todo_id"),
    set_by: label_i64(labels, "set_by"),
    set_at: label_i64(labels, "set_at").unwrap_or(memory.valid_from),
    active: memory.status == "active",
    last_hit_at: memory.last_hit_at,
    hits: memory.hits,
    done_at: memory.valid_to.filter(|_| memory.status == "done"),
    done_text: label(labels, "done_text"),
    down_reason: label(labels, "down_reason"),
    down_at: memory.valid_to.filter(|_| memory.status == "invalidated"),
    candidate_why: label(labels, "candidate_why"),
    candidate_at: label_i64(labels, "candidate_at"),
    event: event.as_deref().and_then(event_of),
    event_met_at: label_i64(labels, "event_met_at"),
    moved_at: label_i64(labels, "moved_at"),
  }
}

/// The conditions the matcher is offered out of these memories: each old condition a moved row kept, and a
/// situation's own text where it kept none.
pub fn conditions(memories: &[Memory]) -> Vec<Condition> {
  let mut found = Vec::new();
  for memory in memories {
    let slug = slug_of(memory);
    let kept = conditions_of(memory);
    if kept.is_empty() && memory.kind == "situation" {
      found.push(Condition {
        slug,
        condition: memory.text.clone(),
        action: memory.text.clone(),
      });
      continue;
    }
    for one in &kept {
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

/// Whether a memory waits on one of these events.
pub fn woken_by(memory: &Memory, events: &[Event]) -> bool {
  let wanted: Vec<String> = events
    .iter()
    .map(|event| match event.item {
      Some(item) => format!("{}:{}", event.kind, item),
      None => event.kind.clone(),
    })
    .collect();
  label(&memory.labels, "event").is_some_and(|said| wanted.iter().any(|one| one == &said))
    || conditions_of(memory).iter().any(|one| {
      let said = one.get("event").and_then(Value::as_str).unwrap_or_default();
      !said.is_empty() && wanted.iter().any(|one| one == said)
    })
}

/// Whether a memory waits on nothing: no condition and no event.
pub fn standing(memory: &Memory) -> bool {
  memory.kind != "situation"
    && label(&memory.labels, "event").is_none()
    && conditions_of(memory).iter().all(|one| {
      one.get("condition").and_then(Value::as_str).unwrap_or_default().is_empty()
        && one.get("event").and_then(Value::as_str).unwrap_or_default().is_empty()
    })
}

/// A memory of the brain as the fragment row a gate is offered: its key is the memory's id, which a hit names
/// it by, and its version the id too, since a memory never changes in place.
pub fn fragment_row(agent: &str, old_kind: &str, memory: &Memory) -> Fragment {
  let labels = &memory.labels;
  Fragment {
    key: memory.id.to_string(),
    kind: label(labels, "kind").unwrap_or_else(|| old_kind.to_owned()),
    chat_id: room_of(memory),
    owner: person_of(memory),
    agent: label(labels, "agent").unwrap_or_else(|| agent.to_owned()),
    all_agents: label(labels, "all_agents")
      .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true")),
    slug: slug_of(memory),
    title: label(labels, "title").unwrap_or_default(),
    path: path_of(memory),
    scope: None,
    section: None,
    position: label_i64(labels, "position").unwrap_or(0),
    active: memory.status == "active",
    last_hit_at: memory.last_hit_at,
    hits: memory.hits,
    set_by: label_i64(labels, "set_by"),
    set_at: label_i64(labels, "set_at").unwrap_or(memory.valid_from),
    hand: None,
    hand_at: None,
    keywords: label_json(labels, "keywords").unwrap_or_default(),
    items: label_json(labels, "items").unwrap_or_default(),
    written_on: label(labels, "written_on"),
    confirmed_on: label(labels, "confirmed_on"),
    status: label(labels, "status").unwrap_or_else(|| "open".to_owned()),
    body_hash: Some(memory.id.to_string()),
  }
}

/// The agent's lore as the fragment rows a gate is offered, in its table of contents' order: each row in its
/// layer's position, then in its own, its section its layer's name, its slug its key after `lore/`, its index line
/// its `title` label with its `scope` label as the line's bracket.
pub fn lore_rows(agent: &str, memories: &[Memory], layers: &[Layer]) -> Vec<Fragment> {
  let layer_of =
    |memory: &Memory| memory.layer_id.and_then(|id| layers.iter().find(|layer| layer.id == id));
  let mut placed: Vec<(i64, &Memory)> = memories
    .iter()
    .map(|memory| (layer_of(memory).map_or(i64::MAX, |layer| layer.position), memory))
    .collect();

  placed.sort_by_key(|(layer, memory)| (*layer, memory.layer_id, memory.position, memory.id));

  placed
    .into_iter()
    .map(|(_, memory)| Fragment {
      slug: lore_slug(memory),
      scope: label(&memory.labels, "scope"),
      position: memory.position,
      section: layer_of(memory).map(|layer| layer.name.clone()),
      ..fragment_row(agent, "lore", memory)
    })
    .collect()
}

/// A person the brain knows facts of as the candidate the person-book search is offered in a room: its slug
/// `person-<number>`, its index line the name the brain knows them by, else their number, its owner the person,
/// and its path their sheet's in the room. A sheet is no row, so its key names no memory and attaching it counts
/// nothing.
pub fn person_row(agent: &str, chat: i64, person: i64, name: Option<&str>) -> Fragment {
  Fragment {
    key: format!("{PERSON_SLUG}{person}"),
    kind: PERSON_BOOK.to_owned(),
    chat_id: Some(chat),
    owner: Some(person),
    agent: agent.to_owned(),
    all_agents: false,
    slug: format!("{PERSON_SLUG}{person}"),
    title: name
      .filter(|name| !name.trim().is_empty())
      .map_or_else(|| person.to_string(), str::to_owned),
    path: sheet_path(chat, person),
    scope: None,
    section: None,
    position: 0,
    active: true,
    last_hit_at: None,
    hits: 0,
    set_by: None,
    set_at: 0,
    hand: None,
    hand_at: None,
    keywords: vec![],
    items: vec![],
    written_on: None,
    confirmed_on: None,
    status: "open".to_owned(),
    body_hash: None,
  }
}

/// The path a person's sheet in a room is handed under.
pub fn sheet_path(chat: i64, person: i64) -> String {
  format!("rooms/{chat}/people/{person}/sheet.md")
}

/// A rule memory as the owner's room rule: its id the memory's key, its grantee the person it is about.
pub fn room_rule(memory: &Memory) -> RoomRule {
  RoomRule {
    id: memory.key.clone().unwrap_or_else(|| memory.id.to_string()),
    subject: label_i64(&memory.labels, "subject").or_else(|| person_of(memory)).unwrap_or(0),
    text: memory.text.clone(),
  }
}
