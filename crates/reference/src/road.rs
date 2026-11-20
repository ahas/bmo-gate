//! The road a turn's reference is composed on (`docs/reference-selection.md`, 「What a turn is given」): the head of
//! the sheet of everyone who spoke, as the brain renders it from their names and facts, the room's due memories and
//! the rows the turn's events wake, held to the turn's total. No model is asked.

use std::collections::HashSet;

use gate_markup::js;
use gate_policy::reference::REFERENCE;
use gate_ports::audience::Audience;
use gate_ports::brain::{BrainKey, MemoryRow};

use crate::{Entry, Reference, SituationTurn, Source, memories, organisation, situation};

/// The brain's kinds the index lists: the shipped reference documents and the lore of the agent's brain, the room's
/// rules, the knowledge and the person book.
pub const SYSTEM_DOCUMENT: &str = "system-document";
pub const LORE: &str = "lore";
pub const ROOM_RULE: &str = "room-rule";
pub const KNOWLEDGE: &str = "library-knowledge";
pub const PERSON_BOOK: &str = "person-book";

/// What a turn is handed to compose its reference by: the room, the message it is about, who spoke, the agent whose
/// turn it is, the audience its org brains are read for, and the situation road where the turn has one.
pub struct Turn {
  pub chat_id: i64,
  pub message_id: Option<i64>,
  pub speaker_ids: Vec<i64>,
  /// The supervisor whose brain alone the turn is read from (`docs/reference-selection.md`, 「Whose reference it
  /// is」).
  pub agent: String,
  /// Whom the org brains are read for (`docs/reference-selection.md`, 「What an organisation hands its members」).
  pub audience: Audience,
  pub situation: Option<SituationTurn>,
}

/// A person's sheet held to the reference's ceiling for one: its lines from the top, every name line and then the
/// most important facts, as many as fit; empty where not even the first does.
pub fn held_sheet(text: &str) -> String {
  let ceiling = REFERENCE.sheet_chars;
  let mut kept: Vec<&str> = vec![];
  let mut used = 0;

  for line in js::trim(text).split('\n') {
    let cost = js::units(line) + usize::from(!kept.is_empty());

    if used + cost > ceiling {
      break;
    }

    used += cost;
    kept.push(line);
  }

  kept.join("\n")
}

/// The head of the standing sheet of everyone who spoke this turn: each one's sheet in the room as the agent's own
/// brain, `key`, renders it, every name line and then as many fact lines as the policy names, held to its ceiling.
/// An agent keeping no brain is given none.
pub async fn standing_entries(
  reference: &Reference,
  chat_id: i64,
  speakers: &[i64],
  key: &BrainKey,
) -> Vec<Entry> {
  let mut seen = HashSet::new();
  let senders: Vec<i64> = speakers.iter().copied().filter(|id| seen.insert(*id)).collect();

  if senders.is_empty() {
    return vec![];
  }

  match reference.brain.sheets(key, chat_id, &senders, Some(REFERENCE.sheet_lines)).await {
    Ok(sheets) => sheets
      .into_iter()
      .map(|sheet| Entry {
        path: sheet.path,
        text: held_sheet(&sheet.text),
        source: Source::Person,
        fragment: None,
      })
      .filter(|entry| !entry.text.is_empty())
      .collect(),
    Err(why) => {
      eprintln!("reference: chat {chat_id} sheets could not be read: {why}");
      vec![]
    }
  }
}

// What a turn carries together: within its total the turn keeps everything; over it, the largest piece goes
// first, the path breaking a tie.
fn within_turn_budget(chat_id: i64, taken: Vec<Entry>) -> Vec<Entry> {
  let budget = REFERENCE.turn_budget_chars;
  let mut total: usize = taken.iter().map(|entry| js::units(&entry.text)).sum();

  if total <= budget {
    return taken;
  }

  let mut order: Vec<usize> = (0..taken.len()).collect();

  order.sort_by(|left, right| {
    let (left, right) = (&taken[*left], &taken[*right]);

    js::units(&right.text).cmp(&js::units(&left.text)).then(left.path.cmp(&right.path))
  });

  let mut dropped = HashSet::new();

  for at in order {
    if total <= budget {
      break;
    }

    let entry = &taken[at];

    dropped.insert(at);
    total -= js::units(&entry.text);
    eprintln!(
      "reference: chat {chat_id} passes over {} at {} characters — the turn is over the {budget} it may carry",
      entry.path,
      js::units(&entry.text)
    );
  }

  taken
    .into_iter()
    .enumerate()
    .filter(|(at, _)| !dropped.contains(at))
    .map(|(_, entry)| entry)
    .collect()
}

/// What a turn is handed (`docs/api.md`, 「Reference」): the head of each speaker's sheet, the org sheet of the person
/// the agent serves, the room's due memories and the rows the turn's events wake, the memories and the woken rows
/// held to the turn's total, all from the turn's agent's own brain and its owner's org brains; nothing where whose
/// brain it is cannot be told.
pub async fn handed(reference: &Reference, turn: &Turn) -> Vec<Entry> {
  let key = match reference.brain_key(&turn.agent).await {
    Ok(key) => key,
    Err(why) => {
      eprintln!(
        "reference: chat {} hands nothing, whose brain it is could not be told: {why}",
        turn.chat_id
      );
      return vec![];
    }
  };
  let woken = async {
    match &turn.situation {
      Some(situation) => situation::event_entries(reference, situation, &key).await,
      None => vec![],
    }
  };
  let (woken, standing, sheets, org_sheet) = tokio::join!(
    woken,
    memories::standing(reference, turn.chat_id, &key),
    standing_entries(reference, turn.chat_id, &turn.speaker_ids, &key),
    organisation::sheet_entry(reference, turn.chat_id, &key, turn.audience)
  );
  let (due, _) = memories::due_first(&standing);
  let carried: Vec<&MemoryRow> = due.iter().collect();
  let memory = memories::memories_entry(turn.chat_id, standing.len(), &carried);
  let kept = within_turn_budget(turn.chat_id, memory.clone().into_iter().chain(woken).collect());
  let mut entries: Vec<Entry> =
    kept.iter().filter(|entry| memory.as_ref() == Some(*entry)).cloned().collect();
  let mut seen: HashSet<String> = entries.iter().map(|entry| entry.path.clone()).collect();

  for entry in sheets
    .into_iter()
    .chain(org_sheet)
    .chain(kept.into_iter().filter(|entry| memory.as_ref() != Some(entry)))
  {
    if seen.insert(entry.path.clone()) {
      entries.push(entry);
    }
  }

  entries
}
