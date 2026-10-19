//! The gates themselves, each on the runs `gate-runs` carries: Laya and the probes it asks, the sanitiser, the
//! output gate, the translator and a document's translation, the reading of a record into the owner's language,
//! the document seeker, Laya's health and how often it agrees with each gate's LLM.

pub mod document_seek;
pub mod document_translation;
pub mod fold;
pub mod laya;
pub mod laya_agreement;
pub mod laya_health;
pub mod markdown;
pub mod markdown_shape;
pub mod ordered;
pub mod output;
pub mod records;
pub mod retention;
pub mod sanitizer;
pub mod sheets;
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

/// One event the gate tells its screens of: its kind and its body.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
  pub kind: &'static str,
  pub body: Value,
}

/// What every gate stands on: the runs, the Laya side, what a text is read by, and the events its screens hear.
pub struct Stages {
  pub runs: Runs,
  pub laya: laya::Side,
  pub reading: Reading,
  pub events: broadcast::Sender<Event>,
}

impl Stages {
  pub fn new(runs: Runs, laya: laya::Side, reading: Reading) -> Self {
    let (events, _) = broadcast::channel(256);

    Self {
      runs,
      laya,
      reading,
      events,
    }
  }

  /// An event told to every screen listening; none listening is no fault.
  pub fn publish(&self, kind: &'static str, body: Value) {
    let _ = self.events.send(Event { kind, body });
  }
}
