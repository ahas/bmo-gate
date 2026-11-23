//! What an organisation hands its members (`docs/reference-selection.md`, 「What an organisation hands its
//! members」): the platform's base and the units the person a supervisor serves stands in, the farthest first, each
//! read where the delegation chain lets the person read that layer, what stands for the person by topic as the org
//! sheet a turn carries, and every other live org memory as the index's `organisation` group, each read for the
//! room's audience, less what the base raised from the supervisor's own brain. No model is asked.

use std::collections::HashSet;

use gate_markup::js;
use gate_policy::fill_marks;
use gate_policy::organisation::ORGANISATION;
use gate_policy::reference::REFERENCE;
use gate_ports::PortError;
use gate_ports::accounts::{BASE_LAYER, ORGANISATION_LAYER, OrgUnit};
use gate_ports::audience::Audience;
use gate_ports::brain::{BrainKey, OrgMemory, OrgTopic};

use crate::{Entry, Reference, Source, memories};

/// The path the org sheet is handed under.
pub const SHEET_PATH: &str = "organisation/sheet.md";

/// One unit of the person's that keeps an org brain, or the platform's base, the farthest of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldUnit {
  pub unit: OrgUnit,
  pub brain: i64,
  /// Whether it is the base rather than a unit.
  pub base: bool,
}

impl HeldUnit {
  /// The base as the farthest unit, under the policy's name for it.
  pub fn base(brain: i64) -> Self {
    Self {
      unit: OrgUnit {
        id: 0,
        name: ORGANISATION.base.clone(),
      },
      brain,
      base: true,
    }
  }

  /// The word a path names it by: the unit's number, or `platform` for the base.
  fn path_word(&self) -> String {
    if self.base { "platform".to_owned() } else { self.unit.id.to_string() }
  }
}

/// One org memory read from a unit or the base, as the index's `organisation` group lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitMemory {
  pub unit: OrgUnit,
  pub base: bool,
  pub memory: OrgMemory,
}

impl UnitMemory {
  /// The entry's slug.
  pub fn slug(&self) -> String {
    format!("org-{}", self.memory.id)
  }

  /// The path a piece read of it is recorded under.
  pub fn path(&self) -> String {
    let held = HeldUnit {
      unit: self.unit.clone(),
      brain: 0,
      base: self.base,
    };

    format!("organisation/{}/{}", held.path_word(), self.memory.id)
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

/// The base and the person's units that keep an org brain, the farthest first, each where the delegation chain lets
/// the person read its layer: none for an agent the brain keeps no brain for; the base alone for a supervisor of no
/// account; and no unit for a person the account service places in none.
pub async fn units(reference: &Reference, key: &BrainKey) -> Result<Vec<HeldUnit>, PortError> {
  if !reference.brain.kept(key).await? {
    return Ok(vec![]);
  }

  let owner = key.owner();
  let reads_base = match owner {
    Some(owner) => reference.accounts.reads(owner, BASE_LAYER).await?,
    None => true,
  };
  let mut held = vec![];

  if reads_base && let Some(base) = reference.brain.base().await? {
    held.push(HeldUnit::base(base));
  }

  let Some(owner) = owner else {
    return Ok(held);
  };

  if !reference.accounts.reads(owner, ORGANISATION_LAYER).await? {
    return Ok(held);
  }

  let Some(placement) = reference.accounts.placement(owner).await? else {
    return Ok(held);
  };

  for unit in placement.farthest_first() {
    if let Some(brain) = reference.brain.org_brain(placement.company.id, unit.id).await? {
      held.push(HeldUnit {
        unit,
        brain,
        base: false,
      });
    }
  }

  Ok(held)
}

/// Whether a memory read from the shared layers is handed to the agent whose brain is named: not one the base raised
/// from that brain, which holds its source.
fn handed(memory: &OrgMemory, own: Option<i64>) -> bool {
  own.is_none() || memory.source_brain != own
}

/// What stands for the person in their units, by topic, as the brain answers it for the audience: less any memory
/// the audience may not read, and a topic left with none.
pub async fn standing(
  reference: &Reference,
  key: &BrainKey,
  units: &[HeldUnit],
  audience: Audience,
) -> Result<Vec<OrgTopic>, PortError> {
  let brains: Vec<i64> = units.iter().map(|held| held.brain).collect();
  let own = reference.brain.own(key).await?;
  let mut standing = reference.brain.org_topics(&brains, audience).await?;

  for topic in &mut standing {
    topic
      .memories
      .retain(|memory| audience.reads(memory.internal_only) && handed(memory, own));
  }

  standing.retain(|topic| !topic.memories.is_empty());

  Ok(standing)
}

/// The audience a read is for: the one the caller names, else the room's as the receiver answers it for the agent,
/// and `External` where the receiver cannot say.
pub async fn audience(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
  named: Option<Audience>,
) -> Audience {
  if let Some(audience) = named {
    return audience;
  }

  match reference.receiver.audience(chat_id, agent).await {
    Ok(audience) => audience,
    Err(why) => {
      eprintln!(
        "reference: chat {chat_id} the org brains are read as external, the room's audience could not be read: {why}"
      );
      Audience::External
    }
  }
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

/// The org sheet a turn carries for the person the agent serves, read for the audience; none where they stand in no
/// organisation, nothing stands for them, or it cannot be read.
pub async fn sheet_entry(
  reference: &Reference,
  chat_id: i64,
  key: &BrainKey,
  audience: Audience,
) -> Option<Entry> {
  let read = async {
    let units = units(reference, key).await?;

    if units.is_empty() {
      return Ok(None);
    }

    let standing = standing(reference, key, &units, audience).await?;

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

/// Every other live org memory of the person's units the audience may read, the unit's order and then the brain's:
/// less those the org sheet carries and those of a topic another unit's word holds. The audience is the one named,
/// else the room's, asked of the receiver only where the person stands in a unit keeping an org brain.
pub async fn rest(
  reference: &Reference,
  key: &BrainKey,
  chat_id: i64,
  named: Option<Audience>,
) -> Result<Vec<UnitMemory>, PortError> {
  let units = units(reference, key).await?;

  if units.is_empty() {
    return Ok(vec![]);
  }

  let audience = audience(reference, chat_id, &key.agent, named).await;
  let standing = standing(reference, key, &units, audience).await?;
  let carried = sheet(&units, &standing).map(|(_, carried)| carried).unwrap_or_default();
  let own = reference.brain.own(key).await?;
  let mut rest = vec![];

  for held in &units {
    let holds = |topic: &String| standing.iter().any(|one| &one.topic == topic && one.brain == held.brain);

    for memory in reference.brain.org_memories(held.brain).await? {
      let stands = memory.topics.is_empty() || memory.topics.iter().any(holds);

      if stands
        && audience.reads(memory.internal_only)
        && !carried.contains(&memory.id)
        && handed(&memory, own)
      {
        rest.push(UnitMemory {
          unit: held.unit.clone(),
          base: held.base,
          memory,
        });
      }
    }
  }

  Ok(rest)
}
