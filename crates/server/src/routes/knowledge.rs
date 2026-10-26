//! Knowledge (`docs/api.md`, 「Knowledge」): the pieces a piece of work's own lines call for, picked from the
//! brain's libraries the agent may be offered.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use bmo_gate_client::{KnowledgeAsk, Piece, Pieces, WorkKnowledgeAsk};
use gate_reference::road::select_knowledge;

use crate::App;
use crate::answer::{Answered, Body};

async fn pieces(app: &App, agent: &str, room_id: i64, lines: &[String]) -> Json<Pieces> {
  // The knowledge picker is shelved: no piece is picked, and a piece of work reads the index itself.
  if gate_policy::gates::GATE_ORDER.is_shelved(gate_reference::road::KNOWLEDGE_GATE) {
    return Json(Pieces { pieces: vec![] });
  }

  let entries = select_knowledge(&app.reference, agent, room_id, lines).await;

  Json(Pieces {
    pieces: entries
      .into_iter()
      .map(|entry| Piece {
        path: entry.path,
        text: entry.text,
      })
      .collect(),
  })
}

pub async fn selected(
  State(app): State<Arc<App>>,
  Body(asked): Body<KnowledgeAsk>,
) -> Answered<Json<Pieces>> {
  Ok(pieces(&app, &asked.agent_name, asked.room_id, &asked.lines).await)
}

pub async fn work(
  State(app): State<Arc<App>>,
  Body(asked): Body<WorkKnowledgeAsk>,
) -> Answered<Json<Pieces>> {
  let agent = app.stages.runs.chat_agent.clone();

  Ok(pieces(&app, &agent, asked.room_id, &asked.lines).await)
}
