//! The gate order (docs/gates.md, 「The gate order」): every gate and where it stands against a chat turn, the
//! list of gates read from it so that no gate is added without a place, and served whole by `GET /gates`.

use std::collections::HashSet;

use serde::Deserialize;

/// One gate's place in a step: its key, and the one condition its step runs under where it runs in some turns
/// only.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Place {
  pub key: String,
  #[serde(default)]
  pub condition: Option<String>,
}

/// The gates a turn starts together and waits on together.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
  pub places: Vec<Place>,
}

/// Where a gate stands: before the reply is written, after it, or outside any turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
  Pre,
  Post,
  Apart,
}

impl Part {
  pub fn as_str(self) -> &'static str {
    match self {
      Part::Pre => "pre",
      Part::Post => "post",
      Part::Apart => "apart",
    }
  }
}

/// One gate as the order lists it: its part, the step it takes there (counted from zero; every gate apart
/// stands on a step of its own), and its place.
#[derive(Clone, Debug)]
pub struct Standing<'a> {
  pub part: Part,
  pub step: usize,
  pub key: &'a str,
  pub condition: Option<&'a str>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateOrder {
  pub pre: Vec<Step>,
  pub post: Vec<Step>,
  pub apart: Vec<String>,
}

impl GateOrder {
  /// Every place of the order, the turn's parts first, then the gates apart, in the order they stand.
  pub fn standing(&self) -> Vec<Standing<'_>> {
    let turn = [(Part::Pre, &self.pre), (Part::Post, &self.post)]
      .into_iter()
      .flat_map(|(part, steps)| {
        steps.iter().enumerate().flat_map(move |(step, held)| {
          held.places.iter().map(move |place| Standing {
            part,
            step,
            key: &place.key,
            condition: place.condition.as_deref(),
          })
        })
      });
    let apart = self.apart.iter().enumerate().map(|(step, key)| Standing {
      part: Part::Apart,
      step,
      key,
      condition: None,
    });

    turn.chain(apart).collect()
  }

  /// Every gate once, where it first stands.
  pub fn keys(&self) -> Vec<&str> {
    let mut seen = HashSet::new();

    self.standing().into_iter().map(|one| one.key).filter(|key| seen.insert(*key)).collect()
  }

  pub fn holds(&self, key: &str) -> bool {
    self.keys().contains(&key)
  }
}

crate::part!(pub GATE_ORDER: GateOrder = "gates.toml");
