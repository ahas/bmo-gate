//! A turn's reference (`docs/api.md`, 「Reference」): what a turn is given with no model, and the brain's index, its
//! pieces and a search of it as the agent reads them itself.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use bmo_gate_client::{
  Entry, IndexGroup, ReferenceAnswer, ReferenceAsk, ReferenceIndex, ReferenceIndexQuery, ReferencePiece,
  ReferencePieceQuery, ReferenceSearch, ReferenceSearchQuery, SearchEntry, SituationEvent,
};
use gate_codes::Code;
use gate_ports::brain::Event;
use gate_reference::SituationTurn;
use gate_reference::index::{self as gate_index, IndexEntry, Unanswered};
use gate_reference::road::{Turn, handed};

use crate::App;
use crate::answer::{Answered, Body, Query, Refused};

/// The turn the envelope stands for.
pub fn turn_of(envelope: ReferenceAsk) -> Turn {
  let situation = envelope.situation.map(|situation| SituationTurn {
    chat_id: envelope.room_id,
    agent: situation.agent_name,
    events: situation
      .events
      .into_iter()
      .map(|event: SituationEvent| Event {
        kind: event.kind,
        item: event.item_id,
      })
      .collect(),
  });

  Turn {
    chat_id: envelope.room_id,
    message_id: envelope.message_id,
    speaker_ids: envelope.speaker_ids,
    situation,
  }
}

pub async fn reference(
  State(app): State<Arc<App>>,
  Body(envelope): Body<ReferenceAsk>,
) -> Answered<Json<ReferenceAnswer>> {
  if let Some(situation) = &envelope.situation
    && !matches!(situation.room_kind.as_str(), "owner" | "group")
  {
    return Err(Refused::new(Code::BadRequest, "the situation's roomKind is neither owner nor group"));
  }

  let entries = handed(&app.reference, &turn_of(envelope)).await;

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

fn unanswered(why: Unanswered) -> Refused {
  match why {
    Unanswered::NoGroup(group) => {
      Refused::new(Code::BadRequest, format!("{group} is no group of the index"))
    }
    Unanswered::NoPiece => Refused::new(Code::NotFound, "its group holds no piece of that slug"),
    Unanswered::Unit(why) => Refused::new(Code::UpstreamFailed, why.to_string()),
  }
}

fn entry_of(entry: IndexEntry) -> bmo_gate_client::IndexEntry {
  bmo_gate_client::IndexEntry {
    slug: entry.slug,
    holds: entry.holds,
    read_when: entry.read_when,
    path: entry.path,
  }
}

fn agent_of<'a>(app: &'a App, agent: &'a Option<String>) -> &'a str {
  agent
    .as_deref()
    .filter(|agent| !agent.trim().is_empty())
    .unwrap_or(app.reference.chat_agent())
}

/// `GET /reference/index`: the brain's index for an agent in a room.
pub async fn index(
  State(app): State<Arc<App>>,
  Query(asked): Query<ReferenceIndexQuery>,
) -> Answered<Json<ReferenceIndex>> {
  let agent = agent_of(&app, &asked.agent);
  let session = asked.session.as_deref().filter(|session| !session.trim().is_empty());
  let groups = gate_index::index(&app.reference, agent, asked.room, session, gate_runs::records::now())
    .await
    .map_err(unanswered)?;

  Ok(Json(ReferenceIndex {
    groups: groups
      .into_iter()
      .map(|group| IndexGroup {
        group: group.group.to_owned(),
        unread: group.unread as u64,
        hint: group.hint,
        entries: group.entries.into_iter().map(entry_of).collect(),
      })
      .collect(),
  }))
}

/// `GET /reference/pieces/{slug}`: one piece read whole, recorded among the session's loads.
pub async fn piece(
  State(app): State<Arc<App>>,
  Path(slug): Path<String>,
  Query(asked): Query<ReferencePieceQuery>,
) -> Answered<Json<ReferencePiece>> {
  let agent = agent_of(&app, &asked.agent);
  let session = asked.session.as_deref().filter(|session| !session.trim().is_empty());
  let piece = gate_index::piece(&app.reference, agent, asked.room, &asked.group, &slug, session)
    .await
    .map_err(unanswered)?;

  Ok(Json(ReferencePiece {
    slug: piece.slug,
    group: piece.group,
    path: piece.path,
    text: piece.text,
  }))
}

/// `GET /reference/search`: the index's entries whose words match a query.
pub async fn search(
  State(app): State<Arc<App>>,
  Query(asked): Query<ReferenceSearchQuery>,
) -> Answered<Json<ReferenceSearch>> {
  if asked.q.trim().is_empty() {
    return Err(Refused::new(Code::BadRequest, "a search names the words it looks for in q"));
  }

  let limit = match asked.limit {
    None => gate_index::SEARCH_DEFAULT,
    Some(limit) if (1..=gate_index::SEARCH_MOST as u32).contains(&limit) => limit as usize,
    Some(limit) => {
      return Err(Refused::new(
        Code::BadRequest,
        format!("limit {limit} is not 1 to {}", gate_index::SEARCH_MOST),
      ));
    }
  };
  let agent = agent_of(&app, &asked.agent);
  let found = gate_index::search(&app.reference, agent, asked.room, &asked.q, limit)
    .await
    .map_err(unanswered)?;

  Ok(Json(ReferenceSearch {
    entries: found
      .into_iter()
      .map(|(group, entry)| SearchEntry {
        slug: entry.slug,
        group: group.to_owned(),
        holds: entry.holds,
        read_when: entry.read_when,
      })
      .collect(),
  }))
}
