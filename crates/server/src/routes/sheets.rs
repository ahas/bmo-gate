//! Person-book sheets (`docs/api.md`, 「Sheets」): one person's sheet of one part, written from the pieces
//! handed in and held under the ceiling.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use bmo_gate_client::{SheetAnswer, SheetAsk as WireAsk};
use gate_stages::sheets::{self, Part, Piece, SheetAsk};

use crate::App;
use crate::answer::{Answered, Body};

pub async fn judge(State(app): State<Arc<App>>, Body(asked): Body<WireAsk>) -> Answered<Json<SheetAnswer>> {
  if !matches!(asked.part.as_str(), "common" | "room") {
    return Err(crate::answer::Refused::new(
      gate_codes::Code::BadRequest,
      "the part is neither common nor room",
    ));
  }

  let ask = SheetAsk {
    agent: asked.agent_name,
    part: if asked.part == "room" { Part::Room } else { Part::Common },
    chat_id: asked.room_id,
    person: asked.person_id,
    pieces: asked
      .pieces
      .into_iter()
      .map(|piece| Piece {
        path: piece.path,
        text: piece.text,
      })
      .collect(),
    ceiling: asked.ceiling,
    registration: asked.registration,
  };

  Ok(Json(SheetAnswer {
    sheet: sheets::judge(&app.stages, &ask).await,
  }))
}
