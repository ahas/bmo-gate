//! A turn's reference (`docs/api.md`, 「Reference」): the reference gates, the person-book search and the
//! situation rules run over one envelope, each on its own road.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use bmo_gate_client::{Entry, ReferenceAnswer, ReferenceAsk, SituationEvent};
use gate_ports::brain::Event;
use gate_reference::road::{Turn, select};
use gate_reference::{RoomKind, SituationTurn};

use crate::App;
use crate::answer::{Answered, Body, Refused};

fn room_kind(word: &str) -> RoomKind {
  if word == "group" { RoomKind::Group } else { RoomKind::Owner }
}

/// The turn the envelope stands for.
pub fn turn_of(envelope: ReferenceAsk) -> Turn {
  let situation = envelope.situation.map(|situation| SituationTurn {
    chat_id: envelope.room_id,
    agent: situation.agent_name,
    message_id: envelope.message_id,
    room: room_kind(&situation.room_kind),
    message_lines: envelope.lines.clone(),
    events: situation
      .events
      .into_iter()
      .map(|event: SituationEvent| Event {
        kind: event.kind,
        item: event.item_id,
      })
      .collect(),
    round: envelope.round.clone(),
    now: situation.now_at,
  });

  Turn {
    chat_id: envelope.room_id,
    message_lines: envelope.lines,
    message_id: envelope.message_id,
    speaker_ids: envelope.speaker_ids,
    situation,
    holds: envelope.holds.map(|holds| holds.into_iter().collect::<HashSet<_>>()),
    round: envelope.round,
    people_spoke: envelope.people_spoke,
    answered: envelope.answered,
    off: envelope.off_gates,
    lore: envelope.lore.unwrap_or(true),
    records: envelope.records,
  }
}

pub async fn reference(
  State(app): State<Arc<App>>,
  Body(envelope): Body<ReferenceAsk>,
) -> Answered<Json<ReferenceAnswer>> {
  if let Some(situation) = &envelope.situation
    && !matches!(situation.room_kind.as_str(), "owner" | "group")
  {
    return Err(Refused::new(
      gate_codes::Code::BadRequest,
      "the situation's roomKind is neither owner nor group",
    ));
  }

  let entries = select(&app.reference, &turn_of(envelope)).await.map_err(Refused::of_run)?;

  Ok(Json(ReferenceAnswer {
    entries: entries
      .into_iter()
      .map(|entry| Entry {
        path: entry.path,
        text: entry.text,
        source: entry.source.as_str().to_owned(),
      })
      .collect(),
  }))
}
