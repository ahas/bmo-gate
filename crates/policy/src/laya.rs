//! The questions Laya is asked (docs/laya.md): the yes/no each probing gate puts over one candidate, and how a
//! candidate is named in it. They stand in `prompts/laya/questions.toml`, in English, word for word as Laya's
//! checkpoints are trained on them, since a question worded otherwise is one no checkpoint has learnt; and the
//! served checkpoints that learnt an earlier wording, which are asked that one instead (`docs/laya.md`, 「Each
//! gate's probe」).

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
  /// The sanitiser's one yes/no over the words: whether they carry security-intrusion material.
  pub intrusion: String,
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

// The earlier wordings' file as the gate reads it: the checkpoints that learnt one, the lists the tooling reads
// left to it.
#[derive(Debug, Deserialize)]
struct Wordings {
  #[serde(default)]
  learnt: BTreeMap<String, BTreeMap<String, String>>,
}

/// The served checkpoints that learnt an earlier wording: each run's folder, without its step, and the wording each
/// of its questions learnt, by the question's id.
pub static LEARNT: LazyLock<BTreeMap<String, BTreeMap<String, String>>> = LazyLock::new(|| {
  crate::read::<Wordings>(
    "prompts/tooling/laya-wordings.toml",
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../prompts/tooling/laya-wordings.toml")),
  )
  .learnt
});

/// The wording a checkpoint is asked a question in: the one it learnt where its run is among the checkpoints that
/// learnt an earlier wording, else `own`, the gate's own. `folder` is the checkpoint's folder as the Laya server's
/// health names it, none where no check has named one.
pub fn wording_for(folder: Option<&str>, question: &str, own: &str) -> String {
  folder
    .and_then(|folder| {
      LEARNT.iter().find(|(run, _)| {
        folder == run.as_str()
          || folder.strip_prefix(run.as_str()).is_some_and(|rest| rest.starts_with('/'))
      })
    })
    .and_then(|(_, questions)| questions.get(question))
    .map_or_else(|| own.to_owned(), Clone::clone)
}
