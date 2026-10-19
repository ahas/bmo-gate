//! The gates that pick a turn's reference out of an index (docs/reference-selection.md): each reference gate in
//! the order its picks stand in a prompt, the person-book search beside them, the situation-rule matcher, and
//! how the road writes down what a turn's gate decided. The question Laya asks of each gate's candidates is
//! Laya's (`crate::laya`).

use serde::Deserialize;

/// When the bot's own lines alone ask a gate.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum BotLinesAlone {
  #[serde(rename = "never")]
  Never,
  #[serde(rename = "own turn")]
  OwnTurn,
  #[serde(rename = "own turn, named items")]
  OwnTurnNamedItems,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceGate {
  pub stage: String,
  pub budget: usize,
  pub hold: u8,
  pub bot_lines_alone: BotLinesAlone,
  pub reads_answered: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PeopleSearch {
  pub stage: String,
  pub cap: usize,
  pub budget: usize,
  pub bot_lines_alone: BotLinesAlone,
  pub reads_answered: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decided {
  pub by_fallback: String,
  pub nothing_attached: String,
  pub no_candidates: String,
  pub no_candidates_detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Situation {
  pub budget: usize,
  pub nothing_matched: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
  pub turn_budget_chars: usize,
  pub gates: Vec<ReferenceGate>,
  pub people: PeopleSearch,
  pub situation: Situation,
  pub decided: Decided,
}

impl Reference {
  pub fn gate(&self, stage: &str) -> Option<&ReferenceGate> {
    self.gates.iter().find(|gate| gate.stage == stage)
  }
}

crate::part!(pub REFERENCE: Reference = "reference.toml");
