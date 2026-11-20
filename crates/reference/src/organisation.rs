//! What an organisation hands its members (`docs/reference-selection.md`, 「What an organisation hands its
//! members」): the units the person a supervisor serves stands in, the farthest first, each unit's org brain, what
//! stands there for the person by topic as the org sheet a turn carries, and every other live org memory as the
//! index's `organisation` group. No model is asked.

use std::collections::HashSet;

use gate_markup::js;
use gate_policy::fill_marks;
use gate_policy::organisation::ORGANISATION;
use gate_policy::reference::REFERENCE;
use gate_ports::PortError;
use gate_ports::accounts::OrgUnit;
use gate_ports::brain::{BrainKey, OrgMemory, OrgTopic};

use crate::{Entry, Reference, Source, memories};

/// The path the org sheet is handed under.
pub const SHEET_PATH: &str = "organisation/sheet.md";

/// One unit of the person's that keeps an org brain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldUnit {
  pub unit: OrgUnit,
  pub brain: i64,
}

/// One org memory read from a unit, as the index's `organisation` group lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitMemory {
  pub unit: OrgUnit,
  pub memory: OrgMemory,
}

impl UnitMemory {
  /// The entry's slug.
  pub fn slug(&self) -> String {
    format!("org-{}", self.memory.id)
  }

  /// The path a piece read of it is recorded under.
  pub fn path(&self) -> String {
    format!("organisation/{}/{}", self.unit.id, self.memory.id)
  }

  /// What the entry holds: its unit's name and the first line of its words.
  pub fn holds(&self) -> String {
    fill_marks(
      &ORGANISATION.index.holds,
      &[("unit", &self.unit.name), ("text", &memories::first_line(&self.memory.text, ""))],
    )
  }

  /// Its piece: its whole words under its unit's name.
  pub fn piece(&self) -> String {
    fill_marks(
      &ORGANISATION.index.piece,
      &[("unit", &self.unit.name), ("text", self.memory.text.trim())],
    )
  }
}

// One line the org sheet may carry: its unit's place among those named, whether its topic is locked, its memory's
// importance and number, and the line itself.
struct SheetLine {
  place: usize,
  locked: bool,
  importance: i64,
  id: i64,
  text: String,
}

/// The person's units that keep an org brain, the farthest first; none for a supervisor of no account, for one the
/// brain keeps no brain for, and for a person the account service places in no unit.
pub async fn units(reference: &Reference, key: &BrainKey) -> Result<Vec<HeldUnit>, PortError> {
  let Some(owner) = key.owner() else {
    return Ok(vec![]);
  };

  if !reference.brain.kept(key).await? {
    return Ok(vec![]);
  }

  let Some(placement) = reference.accounts.placement(owner).await? else {
    return Ok(vec![]);
  };
  let mut held = vec![];

  for unit in placement.farthest_first() {
    if let Some(brain) = reference.brain.org_brain(placement.company.id, unit.id).await? {
      held.push(HeldUnit { unit, brain });
    }
  }

  Ok(held)
}

/// What stands for the person in their units, by topic, as the brain answers it.
pub async fn standing(reference: &Reference, units: &[HeldUnit]) -> Result<Vec<OrgTopic>, PortError> {
  let brains: Vec<i64> = units.iter().map(|held| held.brain).collect();

  reference.brain.org_topics(&brains).await
}

// One line of the sheet as the policy writes it, the memory's words on one line.
fn sheet_line(unit: &OrgUnit, topic: &OrgTopic, memory: &OrgMemory) -> String {
  let lines = &ORGANISATION.sheet;
  let locked = if topic.locked { lines.locked.as_str() } else { "" };
  let words = memory.text.split_whitespace().collect::<Vec<_>>().join(" ");

  fill_marks(
    &lines.line,
    &[
      ("id", &memory.id.to_string()),
      ("unit", &unit.name),
      ("topic", &topic.topic),
      ("locked", locked),
      ("text", &words),
    ],
  )
}

/// The org sheet's text and the memories it carried: the head line, then the lines that fit its ceiling, a locked
/// one first, then the nearer unit's, then the more important, standing in the brain's order; none where nothing
/// stands or no line fits.
pub fn sheet(units: &[HeldUnit], standing: &[OrgTopic]) -> Option<(String, HashSet<i64>)> {
  let mut lines: Vec<SheetLine> = vec![];

  for topic in standing {
    let Some(place) = units.iter().position(|held| held.brain == topic.brain) else {
      continue;
    };

    for memory in &topic.memories {
      lines.push(SheetLine {
        place,
        locked: topic.locked,
        importance: memory.importance,
        id: memory.id,
        text: sheet_line(&units[place].unit, topic, memory),
      });
    }
  }

  let head = &ORGANISATION.sheet.head;
  let mut used = js::units(head);
  let mut order: Vec<usize> = (0..lines.len()).collect();
  let mut kept: HashSet<usize> = HashSet::new();

  order.sort_by(|left, right| {
    let (left_line, right_line) = (&lines[*left], &lines[*right]);

    right_line
      .locked
      .cmp(&left_line.locked)
      .then(right_line.place.cmp(&left_line.place))
      .then(right_line.importance.cmp(&left_line.importance))
      .then(left.cmp(right))
  });

  for at in order {
    let cost = js::units(&lines[at].text) + 1;

    if used + cost <= REFERENCE.organisation_chars {
      used += cost;
      kept.insert(at);
    }
  }

  if kept.is_empty() {
    return None;
  }

  let carried: HashSet<i64> = kept.iter().map(|at| lines[*at].id).collect();
  let text = std::iter::once(head.clone())
    .chain(
      lines
        .iter()
        .enumerate()
        .filter(|(at, _)| kept.contains(at))
        .map(|(_, line)| line.text.clone()),
    )
    .collect::<Vec<_>>()
    .join("\n");

  Some((text, carried))
}

/// The org sheet a turn carries for the person the agent serves; none where they stand in no organisation, nothing
/// stands for them, or it cannot be read.
pub async fn sheet_entry(reference: &Reference, chat_id: i64, key: &BrainKey) -> Option<Entry> {
  let read = async {
    let units = units(reference, key).await?;

    if units.is_empty() {
      return Ok(None);
    }

    let standing = standing(reference, &units).await?;

    Ok::<_, PortError>(sheet(&units, &standing))
  };

  match read.await {
    Ok(sheet) => sheet.map(|(text, _)| Entry {
      path: SHEET_PATH.to_owned(),
      text,
      source: Source::Memory,
      fragment: None,
    }),
    Err(why) => {
      eprintln!("reference: chat {chat_id} the org sheet could not be read: {why}");
      None
    }
  }
}

/// Every other live org memory of the person's units, the unit's order and then the brain's: less those the org
/// sheet carries and those of a topic another unit's word holds.
pub async fn rest(reference: &Reference, key: &BrainKey) -> Result<Vec<UnitMemory>, PortError> {
  let units = units(reference, key).await?;

  if units.is_empty() {
    return Ok(vec![]);
  }

  let standing = standing(reference, &units).await?;
  let carried = sheet(&units, &standing).map(|(_, carried)| carried).unwrap_or_default();
  let mut rest = vec![];

  for held in &units {
    let holds = |topic: &String| standing.iter().any(|one| &one.topic == topic && one.brain == held.brain);

    for memory in reference.brain.org_memories(held.brain).await? {
      let stands = memory.topics.is_empty() || memory.topics.iter().any(holds);

      if stands && !carried.contains(&memory.id) {
        rest.push(UnitMemory {
          unit: held.unit.clone(),
          memory,
        });
      }
    }
  }

  Ok(rest)
}
