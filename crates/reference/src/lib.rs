//! A turn's reference (`docs/reference-selection.md`; `docs/boundary-api.md`, `POST /reference/selected`): what a
//! chat turn is given to read beside the conversation — the room's standing memories, the rows the turn's events
//! wake and the standing sheets of everyone who spoke, which no model chooses, then what the three reference
//! gates, the person-book search and the situation-rule matcher pick, each after the code's narrowing, held to
//! their allowances and the turn's total. The brain answers the rows and reads the pieces; the gate picks.

pub mod attachments;
pub mod fragments;
pub mod memories;
pub mod narrow;
pub mod pick;
pub mod road;
pub mod situation;

use std::path::PathBuf;
use std::sync::Arc;

use gate_ports::brain::{Brain, Event};
use gate_ports::receiver::Receiver;
use gate_stages::Stages;
use serde::{Deserialize, Serialize};

pub use road::{Turn, select};

/// Which sort of thing entered a turn, which is what the turn's log calls it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
  Document,
  Person,
  Rule,
  Situation,
  Knowledge,
  Memory,
  Room,
  Archive,
}

impl Source {
  /// The word the reference answer carries.
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Document => "document",
      Self::Person => "person",
      Self::Rule => "rule",
      Self::Situation => "situation",
      Self::Knowledge => "knowledge",
      Self::Memory => "memory",
      Self::Room => "room",
      Self::Archive => "archive",
    }
  }
}

/// One piece a turn is handed: where it was read from, its text and what sort of thing it is; and, kept to the
/// road, the fragment row it was offered from where it was offered from one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Entry {
  pub path: String,
  pub text: String,
  pub source: Source,
  #[serde(skip)]
  pub fragment: Option<i64>,
}

/// What kind of room a turn is in: the owner's private chat, or a room of several.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomKind {
  Owner,
  Group,
}

/// One turn as the situation road reads it: the room, the agent whose turn it is, the message it is about, the
/// room's kind, the room's recent messages in the room shape with every line the turn brought, the events it
/// carries, the round it belongs to, and the moment it is read at.
#[derive(Clone, Debug)]
pub struct SituationTurn {
  pub chat_id: i64,
  pub agent: String,
  pub message_id: Option<i64>,
  pub room: RoomKind,
  pub message_lines: Vec<String>,
  pub events: Vec<Event>,
  pub round: Option<String>,
  pub now: i64,
}

/// What a turn's reference is composed on: the gates and their runs, the brain the rows and pieces come from, the
/// receiver the names come from, and the folder a shipped piece's body is read under where the deployment places
/// one.
pub struct Reference {
  pub stages: Arc<Stages>,
  pub brain: Arc<dyn Brain>,
  pub receiver: Arc<dyn Receiver>,
  pub shipped: Option<PathBuf>,
}

impl Reference {
  /// The chat agent, whose turn a reference is composed for where nothing names another.
  pub fn chat_agent(&self) -> &str {
    &self.stages.runs.chat_agent
  }
}
