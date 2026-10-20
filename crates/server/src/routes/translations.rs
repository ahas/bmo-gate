//! Translations (`docs/api.md`, 「Translations」): originals read into one language, the readings kept, and the
//! kept ones read back without asking the translator.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use bmo_gate_client::{
  KeepTranslation, KeptQuery, KeptTranslation, Page, Reading, Readings, TranslationAsk,
};
use gate_codes::Code;
use gate_stages::translator::{self, Reader};

use crate::App;
use crate::answer::{Answered, Body, Query, Refused};

fn reader(language: &str) -> Answered<Reader> {
  Reader::of(language)
    .ok_or_else(|| Refused::new(Code::LanguageUnknown, format!("no reader takes {language}")))
}

pub async fn translate(
  State(app): State<Arc<App>>,
  Body(asked): Body<TranslationAsk>,
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

pub async fn kept(
  State(app): State<Arc<App>>,
  Query(asked): Query<KeptQuery>,
) -> Answered<Json<Page<KeptTranslation>>> {
  reader(&asked.language)?;

  let mut items = vec![];

  for original in asked.originals.split(',').filter(|original| !original.is_empty()) {
    if let Some(text) = translator::recalled(&app.stages, &asked.language, original).await {
      items.push(KeptTranslation {
        original: original.to_owned(),
        text,
      });
    }
  }

  Ok(Json(Page::of(items, false)))
}

pub async fn keep(
  State(app): State<Arc<App>>,
  Body(asked): Body<KeepTranslation>,
) -> Answered<Json<KeptTranslation>> {
  reader(&asked.language)?;
  translator::keep(&app.stages, &asked.language, &asked.original, &asked.text)
    .await
    .map_err(Refused::database)?;

  Ok(Json(KeptTranslation {
    original: asked.original,
    text: asked.text,
  }))
}
