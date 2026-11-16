//! The rows a turn's events wake (the brain's `docs/memories.md`; `docs/reference-selection.md`, 「What a turn is
//! given」): a row waiting on one of the turn's events attaches by the event alone, its action under its own name;
//! no model is asked.

use gate_markup::js;
use gate_policy::reference::REFERENCE;
use gate_ports::brain::BrainKey;

use crate::memories;
use crate::{Entry, Reference, SituationTurn, Source};

/// Where a woken situation row's action stands in a turn's log.
pub fn rule_path(slug: &str) -> String {
  format!("situation-rule/{slug}")
}

/// The rows the turn's events wake in the turn's agent's brain, `key`, each attaching its action under its own name
/// within the policy's allowance; no model is asked. A room whose rows cannot be read this turn loses them and
/// nothing else.
pub async fn event_entries(reference: &Reference, turn: &SituationTurn, key: &BrainKey) -> Vec<Entry> {
  let woken = match memories::woken(reference, turn.chat_id, key, &turn.events).await {
    Ok(woken) => woken,
    Err(why) => {
      eprintln!("reference: chat {} events could not be read: {why}", turn.chat_id);
      return vec![];
    }
  };
  let budget = REFERENCE.woken_budget;
  let mut entries = vec![];
  let mut taken = 0;

  for memory in woken {
    let size = js::units(&memory.action);

    if taken + size > budget {
      eprintln!(
        "reference: chat {} passes over {} at {size} characters, which does not fit what is left of its {budget}",
        turn.chat_id, memory.slug
      );
      continue;
    }

    taken += size;
    entries.push(if memory.kind == "situation" {
      Entry {
        path: rule_path(&memory.slug),
        text: memory.action,
        source: Source::Situation,
        fragment: None,
      }
    } else {
      Entry {
        path: format!("memory/{}", memory.slug),
        text: memory.action,
        source: Source::Memory,
        fragment: None,
      }
    });
  }

  entries
}
