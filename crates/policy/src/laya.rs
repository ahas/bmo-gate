//! The questions Laya is asked (docs/laya.md): the yes/no each probing gate puts over one candidate, and how a
//! candidate is named in it. They stand in `prompts/laya/questions.toml`, in the language Laya's checkpoints
//! were trained on, since a question worded otherwise is one no checkpoint has learnt.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

/// A reference gate's question over one candidate, and the word the candidate is named by in it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asked {
  pub question: String,
  pub subject: String,
}

/// The situation-rule matcher's two questions over one rule, and how the rule is named in them (`{slug}` and
/// `{rule}`, its condition and action as one phrase).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SituationQuestions {
  pub applies: String,
  pub spent: String,
  pub about: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Questions {
  /// The one yes/no the fold asks over a message's state: yes is FOLD, no is OPEN.
  pub fold: String,
  /// Each reference gate's and the person-book search's question, by the gate's key.
  pub gates: BTreeMap<String, Asked>,
  pub situation: SituationQuestions,
}

impl Questions {
  pub fn of(&self, stage: &str) -> Option<&Asked> {
    self.gates.get(stage)
  }
}

pub static QUESTIONS: LazyLock<Questions> = LazyLock::new(|| {
  crate::read(
    "prompts/laya/questions.toml",
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../prompts/laya/questions.toml")),
  )
});
