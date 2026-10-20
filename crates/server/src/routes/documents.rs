//! Documents (`docs/api.md`, 「Documents」): the documents a question calls for out of an index, and a document's
//! translation queued part by part, its state and its parts read back.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use bmo_gate_client::{
  DocumentPart, DocumentPartsQuery, DocumentStateQuery, DocumentTranslationOrder, DocumentTranslationState,
  Page, Picks, SeekAsk, SeekEntry, Taken, TranslationFailure, WantedPart,
};
use gate_codes::Code;
use gate_stages::document_seek::{self, SeekEntry as GateSeekEntry};
use gate_stages::document_translation::{self, Order, State as Standing};
use gate_store::entity::document_translations;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};

use crate::App;
use crate::answer::{Answered, Body, Query, Refused};

pub async fn sought(State(app): State<Arc<App>>, Body(asked): Body<SeekAsk>) -> Answered<Json<Picks>> {
  let entries: Vec<GateSeekEntry> = asked
    .entries
    .into_iter()
    .map(|entry: SeekEntry| GateSeekEntry {
      slug: entry.slug,
      line: entry.line,
      group: entry.group,
    })
    .collect();
  let picks = document_seek::sought(&app.stages, &entries, &asked.question)
    .await
    .ok_or_else(|| Refused::new(Code::NoAnswer, "the document seeker gave no answer"))?;

  Ok(Json(Picks { picks }))
}

fn document(name: &str) -> Answered<()> {
  match name.split_once('/') {
    Some((root, path)) if !root.is_empty() && !path.is_empty() => Ok(()),
    _ => Err(Refused::new(Code::DocumentUnknown, format!("{name} is no root and path"))),
  }
}

fn target(language: &str) -> Answered<()> {
  document_translation::language(language)
    .map(drop)
    .ok_or_else(|| Refused::new(Code::LanguageUnknown, format!("the translator takes no {language}")))
}

pub async fn translate(
  State(app): State<Arc<App>>,
  Body(asked): Body<DocumentTranslationOrder>,
) -> Answered<(StatusCode, Json<Taken>)> {
  document(&asked.document)?;
  target(&asked.target)?;

  let taken = app.queue.order(
    &app.stages,
    Order {
      document: asked.document,
      version: asked.version,
      target: asked.target,
      parts: asked.part_count,
      wanted: asked.wanted.into_iter().map(|one: WantedPart| (one.part, one.text)).collect(),
    },
  );

  Ok((StatusCode::ACCEPTED, Json(Taken { taken })))
}

fn standing(state: Standing) -> DocumentTranslationState {
  DocumentTranslationState {
    pending: state.pending,
    failure: state.failure.map(|failure| TranslationFailure {
      reason: failure.reason,
      provider: failure.provider,
      model: failure.model,
    }),
  }
}

pub async fn state(
  State(app): State<Arc<App>>,
  Query(asked): Query<DocumentStateQuery>,
) -> Answered<Json<DocumentTranslationState>> {
  document(&asked.document)?;
  target(&asked.target)?;

  Ok(Json(standing(app.queue.state(&asked.document, &asked.target))))
}

pub async fn parts(
  State(app): State<Arc<App>>,
  Query(asked): Query<DocumentPartsQuery>,
) -> Answered<Json<Page<DocumentPart>>> {
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

  Ok(Json(Page::of(
    rows
      .into_iter()
      .map(|row| DocumentPart {
        part: row.part,
        text: row.text,
        failed: row.failed != 0,
      })
      .collect(),
    false,
  )))
}
