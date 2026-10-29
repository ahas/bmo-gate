//! The gates a turn's text passes: the translator and a document's translation, and the reading of a record into
//! the owner's language.

pub mod document_translation;
pub mod markdown;
pub mod markdown_shape;
pub mod records;
pub mod sql;
pub mod translator;

use std::path::PathBuf;

use gate_markup::english::EnglishTest;
use gate_markup::wording::{BannedTerm, parse_glossary};
use gate_policy::translation::TRANSLATION;
use gate_runs::Runs;
use serde_json::Value;
use tokio::sync::broadcast;

/// What a text is read by: the words the English test reads past, and the file the owner's banned words are read
/// from, where the deployment keeps one.
#[derive(Clone, Debug, Default)]
pub struct Reading {
  pub set_aside: Vec<String>,
  pub wording: Option<PathBuf>,
}

impl Reading {
  /// The English test the readings weigh a text by.
  pub fn english(&self) -> EnglishTest {
    EnglishTest::new(&self.set_aside, TRANSLATION.latin_per_hangul)
  }

  /// The owner's banned words, or none where no file is named or it does not read: a text is not held to a
  /// document nobody can read.
  pub fn glossary(&self) -> Vec<BannedTerm> {
    self
      .wording
      .as_ref()
      .and_then(|path| std::fs::read_to_string(path).ok())
      .and_then(|text| parse_glossary(&text).ok())
      .unwrap_or_default()
  }
}

/// One event the gate tells its readers of: its number, its kind, when it happened and the member it carries.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
  pub id: i64,
  pub kind: &'static str,
  pub at: i64,
  pub data: Value,
}

/// What every gate stands on: the runs, what a text is read by, and the events its readers hear.
pub struct Stages {
  pub runs: Runs,
  pub reading: Reading,
  pub events: broadcast::Sender<Event>,
  next_event: std::sync::atomic::AtomicI64,
}

impl Stages {
  pub fn new(runs: Runs, reading: Reading) -> Self {
    let (events, _) = broadcast::channel(256);

    Self {
      runs,
      reading,
      events,
      next_event: std::sync::atomic::AtomicI64::new(1),
    }
  }

  /// An event told to every reader listening; none listening is no fault.
  pub fn publish(&self, kind: &'static str, data: Value) {
    let id = self.next_event.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let at = gate_runs::records::now();

    let _ = self.events.send(Event { id, kind, at, data });
  }
}
