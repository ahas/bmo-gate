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
use gate_ports::audience::Audience;
use gate_ports::brain::{BrainKey, Event};
use gate_reference::SituationTurn;
use gate_reference::index::{self as gate_index, IndexEntry, Unanswered};
use gate_reference::road::{Turn, handed};

use crate::App;
use crate::answer::{Answered, Body, Query, Refused};

// The agent an envelope names, by its situation or its `agent`, refused where it names nobody or the two name
// different agents (`docs/reference-selection.md`, 「Whose reference it is」).
fn named_agent(envelope: &ReferenceAsk) -> Result<String, Refused> {
  let named = |agent: &str| Some(agent.trim().to_owned()).filter(|agent| !agent.is_empty());
  let by_situation = envelope.situation.as_ref().and_then(|situation| named(&situation.agent_name));
  let by_field = envelope.agent.as_deref().and_then(named);

  match (by_situation, by_field) {
    (Some(situation), Some(field)) if situation != field => Err(Refused::new(
      Code::BadRequest,
      "the envelope's agent and its situation's agentName name two agents",
    )),
    (Some(agent), _) | (None, Some(agent)) => Ok(agent),
    (None, None) => Err(Refused::new(
      Code::BadRequest,
      "a turn is read for the agent its situation or its agent names, and none is named",
    )),
  }
}

/// The audience a caller names, as the reference road reads it.
fn audience_of(named: bmo_gate_client::Audience) -> Audience {
  match named {
    bmo_gate_client::Audience::Internal => Audience::Internal,
    bmo_gate_client::Audience::External => Audience::External,
  }
}

/// The turn the envelope stands for, refused where it names no agent or two. An envelope naming no audience is read
/// `External` where it carries a situation, a room's chat turn, and `Internal` where it carries none
/// (`docs/reference-selection.md`, 「What an organisation hands its members」).
pub fn turn_of(envelope: ReferenceAsk) -> Result<Turn, Refused> {
  let agent = named_agent(&envelope)?;
  let audience = match (envelope.audience, &envelope.situation) {
    (Some(named), _) => audience_of(named),
    (None, Some(_)) => Audience::External,
    (None, None) => Audience::Internal,
  };
  let situation = envelope.situation.map(|situation| SituationTurn {
    chat_id: envelope.room_id,
    agent: agent.clone(),
    events: situation
      .events
      .into_iter()
      .map(|event: SituationEvent| Event {
        kind: event.kind,
        item: event.item_id,
      })
      .collect(),
  });

  Ok(Turn {
    chat_id: envelope.room_id,
    message_id: envelope.message_id,
    speaker_ids: envelope.speaker_ids,
    agent,
    audience,
    situation,
  })
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

  let entries = handed(&app.reference, &turn_of(envelope)?).await;

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

// Whose brain an index, a piece or a search is read from: the named agent's own, never the chat agent's in its
// place (`docs/reference-selection.md`, 「Whose reference it is」).
async fn brain_key(app: &App, agent: &str) -> Result<BrainKey, Refused> {
  if agent.trim().is_empty() {
    return Err(Refused::new(
      Code::BadRequest,
      "the index is read for the agent named in agent, and none is named",
    ));
  }

  app.reference.brain_key(agent).await.map_err(|why| unanswered(Unanswered::Unit(why)))
}

/// `GET /reference/index`: the brain's index for an agent in a room.
pub async fn index(
  State(app): State<Arc<App>>,
  Query(asked): Query<ReferenceIndexQuery>,
) -> Answered<Json<ReferenceIndex>> {
  let key = brain_key(&app, &asked.agent).await?;
  let session = asked.session.as_deref().filter(|session| !session.trim().is_empty());
  let audience = asked.audience.map(audience_of);
  let groups =
    gate_index::index(&app.reference, &key, asked.room, session, audience, gate_runs::records::now())
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
  let key = brain_key(&app, &asked.agent).await?;
  let session = asked.session.as_deref().filter(|session| !session.trim().is_empty());
  let audience = asked.audience.map(audience_of);
  let piece = gate_index::piece(&app.reference, &key, asked.room, &asked.group, &slug, session, audience)
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
  let key = brain_key(&app, &asked.agent).await?;
  let audience = asked.audience.map(audience_of);
  let found = gate_index::search(&app.reference, &key, asked.room, &asked.q, limit, audience)
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
