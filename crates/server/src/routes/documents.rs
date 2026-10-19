//! Documents for the console (`docs/boundary-api.md`, 「For the console」): the documents a question calls for out
//! of an index, and a document's translation queued part by part, its state and its parts read back.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use gate_codes::Code;
use gate_stages::document_seek::{SeekEntry, sought as seek};
use gate_stages::document_translation::{self, Order, State as Standing};
use gate_store::entity::document_translations;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::{Deserialize, Serialize};

use crate::App;
use crate::answer::{Answered, Body, Query, Refused};

#[derive(Deserialize)]
pub struct Seek {
  pub question: String,
  pub entries: Vec<SeekEntry>,
}

#[derive(Serialize)]
pub struct Picks {
  pub picks: Vec<String>,
}

pub async fn sought(State(app): State<Arc<App>>, Body(asked): Body<Seek>) -> Answered<Json<Picks>> {
  let picks = seek(&app.stages, &asked.entries, &asked.question)
    .await
    .ok_or_else(|| Refused::new(Code::NoAnswer, "the document seeker gave no answer"))?;

  Ok(Json(Picks { picks }))
}

/// A document's name, refused `document_unknown` where it is no root and path.
fn document(name: &str) -> Answered<()> {
  match name.split_once('/') {
    Some((root, path)) if !root.is_empty() && !path.is_empty() => Ok(()),
    _ => Err(Refused::new(Code::DocumentUnknown, format!("{name} is no root and path"))),
  }
}

/// A target language, refused `language_unknown` where the translator does not take it.
fn target(language: &str) -> Answered<()> {
  document_translation::language(language)
    .map(drop)
    .ok_or_else(|| Refused::new(Code::LanguageUnknown, format!("the translator takes no {language}")))
}

#[derive(Deserialize)]
pub struct Wanted {
  pub part: i64,
  pub text: String,
}

#[derive(Deserialize)]
pub struct Ordered {
  pub document: String,
  pub version: String,
  pub target: String,
  pub parts: i64,
  pub wanted: Vec<Wanted>,
}

#[derive(Serialize)]
pub struct Taken {
  pub taken: usize,
}

pub async fn translate(
  State(app): State<Arc<App>>,
  Body(asked): Body<Ordered>,
) -> Answered<(StatusCode, Json<Taken>)> {
  document(&asked.document)?;
  target(&asked.target)?;

  let taken = app.queue.order(
    &app.stages,
    Order {
      document: asked.document,
      version: asked.version,
      target: asked.target,
      parts: asked.parts,
      wanted: asked.wanted.into_iter().map(|one| (one.part, one.text)).collect(),
    },
  );

  Ok((StatusCode::ACCEPTED, Json(Taken { taken })))
}

#[derive(Deserialize)]
pub struct Named {
  pub document: String,
  pub target: String,
}

pub async fn state(State(app): State<Arc<App>>, Query(asked): Query<Named>) -> Answered<Json<Standing>> {
  document(&asked.document)?;
  target(&asked.target)?;

  Ok(Json(app.queue.state(&asked.document, &asked.target)))
}

#[derive(Deserialize)]
pub struct Version {
  pub document: String,
  pub version: String,
  pub target: String,
}

#[derive(Serialize)]
pub struct Part {
  pub part: i64,
  pub text: Option<String>,
  pub failed: bool,
}

#[derive(Serialize)]
pub struct Parts {
  pub parts: Vec<Part>,
}

pub async fn parts(State(app): State<Arc<App>>, Query(asked): Query<Version>) -> Answered<Json<Parts>> {
  document(&asked.document)?;
  target(&asked.target)?;

  let rows = document_translations::Entity::find()
    .filter(document_translations::Column::Document.eq(asked.document))
    .filter(document_translations::Column::Version.eq(asked.version))
    .filter(document_translations::Column::Target.eq(asked.target))
    .order_by_asc(document_translations::Column::Part)
    .all(&app.stages.runs.db)
    .await
    .map_err(Refused::database)?;

  Ok(Json(Parts {
    parts: rows
      .into_iter()
      .map(|row| Part {
        part: row.part,
        text: row.text,
        failed: row.failed != 0,
      })
      .collect(),
  }))
}
