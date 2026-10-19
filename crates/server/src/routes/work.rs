//! For bmo-job and bmo-artifact (`docs/boundary-api.md`, 「For bmo-job」, 「For bmo-artifact」): kept translations read
//! and kept, originals translated, and the knowledge a piece of work is handed.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use gate_codes::Code;
use gate_reference::road::select_knowledge;
use gate_stages::translator::{self, Reader};
use serde::{Deserialize, Serialize};

use crate::App;
use crate::answer::{Answered, Body, Refused};

#[derive(Deserialize)]
pub struct Originals {
  pub language: String,
  pub originals: Vec<String>,
}

fn reader(language: &str) -> Answered<Reader> {
  Reader::of(language)
    .ok_or_else(|| Refused::new(Code::LanguageUnknown, format!("no reader takes {language}")))
}

#[derive(Serialize)]
pub struct KeptOne {
  pub original: String,
  pub text: String,
}

#[derive(Serialize)]
pub struct Kept {
  pub kept: Vec<KeptOne>,
}

pub async fn kept(State(app): State<Arc<App>>, Body(asked): Body<Originals>) -> Answered<Json<Kept>> {
  reader(&asked.language)?;

  let mut kept = vec![];

  for original in asked.originals {
    if let Some(text) = translator::recalled(&app.stages, &asked.language, &original).await {
      kept.push(KeptOne { original, text });
    }
  }

  Ok(Json(Kept { kept }))
}

#[derive(Serialize)]
pub struct Reading {
  pub text: String,
  pub whole: bool,
}

#[derive(Serialize)]
pub struct Readings {
  pub readings: Vec<Reading>,
}

pub async fn translate(
  State(app): State<Arc<App>>,
  Body(asked): Body<Originals>,
) -> Answered<Json<Readings>> {
  reader(&asked.language)?;

  let ask = translator::by_gate(app.stages.clone());
  let read = translator::readings(&app.stages, &asked.language, &asked.originals, &ask)
    .await
    .ok_or_else(|| Refused::new(Code::LanguageUnknown, format!("no reader takes {}", asked.language)))?;

  Ok(Json(Readings {
    readings: read
      .into_iter()
      .map(|one| Reading {
        text: one.text,
        whole: one.whole,
      })
      .collect(),
  }))
}

#[derive(Deserialize)]
pub struct Keep {
  pub language: String,
  pub original: String,
  pub text: String,
}

pub async fn keep(State(app): State<Arc<App>>, Body(asked): Body<Keep>) -> Answered<StatusCode> {
  reader(&asked.language)?;
  translator::keep(&app.stages, &asked.language, &asked.original, &asked.text)
    .await
    .map_err(Refused::database)?;

  Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct Piece {
  pub path: String,
  pub text: String,
}

#[derive(Serialize)]
pub struct Pieces {
  pub pieces: Vec<Piece>,
}

#[derive(Deserialize)]
pub struct Selected {
  pub agent: String,
  pub chat: i64,
  pub lines: Vec<String>,
}

async fn pieces(app: &App, agent: &str, chat: i64, lines: &[String]) -> Json<Pieces> {
  let entries = select_knowledge(&app.reference, agent, chat, lines).await;

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

pub async fn selected(State(app): State<Arc<App>>, Body(asked): Body<Selected>) -> Answered<Json<Pieces>> {
  Ok(pieces(&app, &asked.agent, asked.chat, &asked.lines).await)
}

#[derive(Deserialize)]
pub struct Work {
  pub chat_id: i64,
  pub lines: Vec<String>,
}

pub async fn for_work(State(app): State<Arc<App>>, Body(asked): Body<Work>) -> Answered<Json<Pieces>> {
  let agent = app.stages.runs.chat_agent.clone();

  Ok(pieces(&app, &agent, asked.chat_id, &asked.lines).await)
}
