//! A turn's reference (`docs/reference-selection.md`; `docs/boundary-api.md`, `POST /reference/selected`): what a
//! chat turn is given to read beside the conversation — the room's due memories, the rows the turn's events wake,
//! the standing sheets of everyone who spoke and the holders' sheet of what a host service left standing in the
//! agent's brain, which no model chooses, the memories and the woken rows held to the turn's total and every sheet
//! to a ceiling of its own — and the brain's index an agent reads the rest through itself. The brain answers the
//! rows and reads the pieces.

pub mod fragments;
pub mod holders;
pub mod index;
pub mod memories;
pub mod organisation;
pub mod road;
pub mod situation;

use std::path::PathBuf;
use std::sync::Arc;

use gate_ports::PortError;
use gate_ports::accounts::Accounts;
use gate_ports::brain::{Brain, BrainKey, Event};
use gate_ports::receiver::Receiver;
use gate_stages::Stages;
use serde::{Deserialize, Serialize};

pub use road::{Turn, handed};

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

/// One turn as the situation road reads it: the room, the agent whose turn it is, and the events it carries.
#[derive(Clone, Debug)]
pub struct SituationTurn {
  pub chat_id: i64,
  pub agent: String,
  pub events: Vec<Event>,
}

/// What a turn's reference is composed on: the gates and their runs, the brain the rows and pieces come from, the
/// account service a person's units come from, the receiver the names come from, and the folder a shipped piece's
/// body is read under where the deployment places one.
pub struct Reference {
  pub stages: Arc<Stages>,
  pub brain: Arc<dyn Brain>,
  pub accounts: Arc<dyn Accounts>,
  pub receiver: Arc<dyn Receiver>,
  pub shipped: Option<PathBuf>,
}

impl Reference {
  /// Whose brain the agent's reference is read from (`docs/reference-selection.md`, 「Whose reference it is」): the
  /// brain the account owning it files it under, else, for an agent no account owns, the one brain of its name.
  pub async fn brain_key(&self, agent: &str) -> Result<BrainKey, PortError> {
    let owner = self
      .stages
      .runs
      .agency
      .supervisor(agent)
      .await?
      .and_then(|supervisor| supervisor.owner_account);

    Ok(match owner {
      Some(user) => BrainKey::owned(agent, user),
      None => BrainKey::unowned(agent),
    })
  }
}
