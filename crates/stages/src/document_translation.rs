//! A document's translation, ordered by the web unit's document viewer (`docs/boundary-api.md`, `POST
//! /documents/translations`): the parts it wants translated of one version, queued and answered at once, a few out
//! at the translator at a time, each part written as a row of the document's translation once it comes back with
//! its structure kept — asked once more where it lost it, and kept as failed where it lost it twice, with what the
//! last answer lost — and a word to the screens as each part ends. A newer order for the same document and language
//! drops the older version's parts still waiting, and its own go first.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use gate_policy::{fill_marks, prompts};
use gate_runs::records::now;
use gate_runs::{GateError, GateRequest, Piece, Split, route};
use gate_words::translation as words;
use regex::Regex;
use sea_orm::TransactionTrait;
use serde_json::json;

use crate::Stages;
use crate::markdown::{halve_text, heading_shape, inline_code};
use crate::markdown_shape::block_shape;
use crate::sql::{one, run};

/// The gate's key, the worker translation's own.
pub const STAGE: &str = crate::translator::STAGE;

// How many parts are out at the translator at once.
const LANES: usize = 3;

static WRAPPED: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^```[a-z]*\n([\s\S]*?)\n```\s*$").expect("a fence"));

/// The languages a document is translated into, by the code the viewer names them with.
pub fn language(target: &str) -> Option<&'static str> {
  match target {
    "ko" => Some("Korean"),
    "en" => Some("English"),
    _ => None,
  }
}

// A model that wraps its whole answer in a fence has put the translation inside it.
fn unwrap(answer: &str, source: &str) -> String {
  let trimmed = answer.trim();

  match WRAPPED.captures(trimmed) {
    Some(found) if !source.trim_start().starts_with("```") => found[1].to_owned(),
    _ => trimmed.to_owned(),
  }
}

/// One part as the translator is asked it: beside the gate's other runs, and cut in two at a paragraph where its
/// road finds it too large, the halves joined in order and a half with no answer leaving the whole unanswered.
pub fn request(text: &str, target: &str, system: &Arc<String>) -> GateRequest {
  let language = language(target).unwrap_or("English");
  let mut asked = GateRequest::new(system.as_str(), format!("Translate into {language}.\n\n{text}"));

  asked.thinking = false;
  asked.alongside = true;
  asked.split = Some(Arc::new(Halves {
    text: text.to_owned(),
    target: target.to_owned(),
    system: Arc::clone(system),
  }));
  asked
}

struct Halves {
  text: String,
  target: String,
  system: Arc<String>,
}

impl Split for Halves {
  fn halve(&self) -> Option<Vec<Piece>> {
    let (halves, _) = halve_text(&self.text)?;

    Some(
      halves
        .iter()
        .map(|half| Piece::Asked(request(half, &self.target, &self.system)))
        .collect(),
    )
  }

  fn join(&self, answers: Vec<Option<String>>) -> Option<String> {
    let (halves, joint) = halve_text(&self.text)?;
    let answered: Option<Vec<String>> = answers
      .into_iter()
      .enumerate()
      .map(|(at, answer)| answer.map(|answer| unwrap(&answer, halves.get(at).map_or("", String::as_str))))
      .collect();

    answered.map(|answered| answered.join(joint))
  }
}

/// What one part came to: its translation, its structure lost twice with what the last answer lost, or no answer.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "text", rename_all = "camelCase")]
pub enum Outcome {
  Translated(String),
  Mismatch(Lost),
  Unanswered,
}

/// What an answer lost of its part's structure, said as a sentence where a part is kept as failed.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(into = "String")]
pub enum Lost {
  /// Its headings at each depth, as `heading_shape` writes them.
  Headings { source: String, translated: String },
  /// As many blocks as the part has.
  Blocks { source: usize, translated: usize },
  /// A block of the part's kind in its place, counted from 1.
  Block {
    at: usize,
    source: &'static str,
    translated: &'static str,
  },
  /// An inline code span of the part, marks and all.
  Code(String),
}

impl std::fmt::Display for Lost {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let said = match self {
      Self::Headings { source, translated } => fill_marks(
        words::LOST_HEADINGS,
        &[("source", none_if_empty(source)), ("translated", none_if_empty(translated))],
      ),
      Self::Blocks { source, translated } => fill_marks(
        words::LOST_BLOCKS,
        &[("source", &source.to_string()), ("translated", &translated.to_string())],
      ),
      Self::Block {
        at,
        source,
        translated,
      } => fill_marks(
        words::LOST_BLOCK,
        &[("at", &at.to_string()), ("source", source), ("translated", translated)],
      ),
      Self::Code(span) => fill_marks(words::LOST_CODE, &[("span", span)]),
    };

    f.write_str(&said)
  }
}

impl From<Lost> for String {
  fn from(lost: Lost) -> Self {
    lost.to_string()
  }
}

// A heading shape as a sentence names it: no headings at all is said so.
fn none_if_empty(shape: &str) -> &str {
  if shape.is_empty() { "none" } else { shape }
}

/// What of its part's structure an answer must keep to stand as its translation, by what its reader checks itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kept {
  /// Its headings at each depth, its blocks in their order, and every inline code span word for word
  /// (`docs/api.md`, 「Documents」). The gate's own words beside the translation (a line introducing it, a
  /// separator, a remark after it) add blocks, and words in its place (a refusal, a question back, a summary) lose
  /// blocks or code, so neither passes for a translation; a blank line added or dropped beside a heading or a list
  /// moves no block, so a translation laid out anew still passes.
  Whole,
  /// Its headings alone, for a reader that checks the rest with its own faults and asks again naming them.
  Headings,
}

impl Kept {
  /// What `translated` lost of what `source` must keep, or none where it kept it all.
  pub fn lost(self, source: &str, translated: &str) -> Option<Lost> {
    let (headings, translated_headings) = (heading_shape(source), heading_shape(translated));

    if headings != translated_headings {
      return Some(Lost::Headings {
        source: headings,
        translated: translated_headings,
      });
    }

    if self == Self::Headings {
      return None;
    }

    let (blocks, translated_blocks) = (block_shape(source), block_shape(translated));

    if blocks.len() != translated_blocks.len() {
      return Some(Lost::Blocks {
        source: blocks.len(),
        translated: translated_blocks.len(),
      });
    }

    if let Some(at) = blocks.iter().zip(&translated_blocks).position(|(one, other)| one != other) {
      return Some(Lost::Block {
        at: at + 1,
        source: blocks[at],
        translated: translated_blocks[at],
      });
    }

    inline_code(source)
      .into_iter()
      .find(|span| !translated.contains(span.as_str()))
      .map(Lost::Code)
  }
}

/// One part translated through `run`, its answer standing where it keeps what `kept` names.
pub async fn translate_part<F, Fut>(
  text: &str,
  target: &str,
  system: &Arc<String>,
  kept: Kept,
  run: F,
) -> Outcome
where
  F: Fn(GateRequest) -> Fut,
  Fut: Future<Output = Option<String>>,
{
  let mut asked = 1;

  loop {
    let Some(answer) = run(request(text, target, system)).await else {
      return Outcome::Unanswered;
    };
    let translated = unwrap(&answer, text);

    match kept.lost(text, &translated) {
      None => return Outcome::Translated(translated),
      Some(lost) if asked >= 2 => return Outcome::Mismatch(lost),
      Some(_) => asked += 1,
    }
  }
}

/// Why a document's translation last stopped short, with the road it was asked on where one stood.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Failure {
  pub reason: String,
  pub provider: Option<String>,
  pub model: Option<String>,
}

/// Where one document's translation into one language stands.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct State {
  pub pending: usize,
  pub failure: Option<Failure>,
}

/// An order: the parts wanted of one version, out of how many it has.
pub struct Order {
  pub document: String,
  pub version: String,
  pub target: String,
  pub parts: i64,
  pub wanted: Vec<(i64, String)>,
}

#[derive(Clone)]
struct Part {
  document: String,
  version: String,
  target: String,
  parts: i64,
  part: i64,
  text: String,
}

fn state_key(document: &str, target: &str) -> String {
  format!("{target}:{document}")
}

fn part_key(part: &Part) -> String {
  format!("{}:{}:{}", state_key(&part.document, &part.target), part.version, part.part)
}

#[derive(Default)]
struct Held {
  waiting: VecDeque<Part>,
  queued: HashSet<String>,
  states: HashMap<String, State>,
  running: usize,
}

/// The service's queue of parts.
#[derive(Clone, Default)]
pub struct Queue(Arc<Mutex<Held>>);

impl Queue {
  fn held(&self) -> std::sync::MutexGuard<'_, Held> {
    self.0.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// Where one document's translation into one language stands.
  pub fn state(&self, document: &str, target: &str) -> State {
    self.held().states.get(&state_key(document, target)).cloned().unwrap_or_default()
  }

  /// An order taken: how many of its parts were new to the queue.
  pub fn order(&self, stages: &Arc<Stages>, order: Order) -> usize {
    let key = state_key(&order.document, &order.target);
    let taken = {
      let mut held = self.held();
      let mut mine = Vec::new();
      let mut others = Vec::new();
      let mut dropped = 0;

      held.states.entry(key.clone()).or_default().failure = None;

      for part in std::mem::take(&mut held.waiting) {
        if state_key(&part.document, &part.target) != key {
          others.push(part);
        } else if part.version == order.version {
          mine.push(part);
        } else {
          held.queued.remove(&part_key(&part));
          dropped += 1;
        }
      }

      let mut taken = 0;

      for (number, text) in order.wanted {
        let part = Part {
          document: order.document.clone(),
          version: order.version.clone(),
          target: order.target.clone(),
          parts: order.parts,
          part: number,
          text,
        };

        if held.queued.insert(part_key(&part)) {
          mine.push(part);
          taken += 1;
        }
      }

      let state = held.states.entry(key).or_default();

      state.pending = state.pending.saturating_sub(dropped) + taken;
      mine.sort_by_key(|part| part.part);
      held.waiting = mine.into_iter().chain(others).collect();
      taken
    };

    self.pump(stages);
    taken
  }

  fn pump(&self, stages: &Arc<Stages>) {
    loop {
      let part = {
        let mut held = self.held();

        if held.running >= LANES {
          return;
        }

        let Some(part) = held.waiting.pop_front() else { return };

        held.running += 1;
        part
      };
      let (queue, stages) = (self.clone(), Arc::clone(stages));

      tokio::spawn(async move {
        queue.translate(&stages, part).await;
        queue.held().running -= 1;
        queue.pump(&stages);
      });
    }
  }

  async fn translate(&self, stages: &Stages, part: Part) {
    let system = prompts::instructions(STAGE)
      .map(|system| Arc::new(system.to_owned()))
      .ok_or_else(|| format!("{STAGE}: its instructions are not among the prompts"));
    // A run somebody stopped ends the part with nothing kept and no failure: it was asked to stop.
    let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let outcome = match &system {
      Ok(system) => {
        let outcome = translate_part(&part.text, &part.target, system, Kept::Whole, |request| {
          let stopped = Arc::clone(&stopped);

          async move {
            match stages.runs.run(STAGE, &request).await {
              Ok(answer) => answer,
              Err(GateError::Stopped(_)) => {
                stopped.store(true, std::sync::atomic::Ordering::SeqCst);
                None
              }
              Err(why) => {
                eprintln!("translator: {why}");
                None
              }
            }
          }
        })
        .await;

        (!stopped.load(std::sync::atomic::Ordering::SeqCst)).then_some(outcome)
      }
      Err(why) => {
        eprintln!("translator: {why}");
        None
      }
    };
    let detail: Option<String> = match outcome {
      None if stopped.load(std::sync::atomic::Ordering::SeqCst) => Some(words::STOPPED.to_owned()),
      Some(Outcome::Unanswered) => {
        let route = route::read(&stages.runs, STAGE).await.ok();
        let failure = Failure {
          reason: words::UNANSWERED.to_owned(),
          provider: route.as_ref().map(|route| route.provider.clone()),
          model: route.as_ref().map(|route| route.model().to_owned()),
        };

        self.held().states.entry(state_key(&part.document, &part.target)).or_default().failure =
          Some(failure);
        Some(words::UNANSWERED.to_owned())
      }
      Some(outcome) => {
        let (text, failure) = match outcome {
          Outcome::Translated(text) => (Some(text), None),
          Outcome::Mismatch(lost) => {
            eprintln!("translator: {} part {} is kept as failed: {lost}", part.document, part.part);
            (None, Some(lost.to_string()))
          }
          Outcome::Unanswered => (None, Some(words::UNANSWERED.to_owned())),
        };

        match save(stages, &part, text, failure).await {
          Ok(()) => None,
          Err(why) => {
            eprintln!("translator: {} part {} failed: {why}", part.document, part.part);
            self.held().states.entry(state_key(&part.document, &part.target)).or_default().failure =
              Some(Failure {
                reason: words::UNWRITTEN.to_owned(),
                provider: None,
                model: None,
              });
            Some(words::UNWRITTEN.to_owned())
          }
        }
      }
      None => {
        self.held().states.entry(state_key(&part.document, &part.target)).or_default().failure =
          Some(Failure {
            reason: words::UNWRITTEN.to_owned(),
            provider: None,
            model: None,
          });
        Some(words::UNWRITTEN.to_owned())
      }
    };

    {
      let mut held = self.held();

      held.queued.remove(&part_key(&part));

      let state = held.states.entry(state_key(&part.document, &part.target)).or_default();

      state.pending = state.pending.saturating_sub(1);
    }

    stages.publish("document-translation.changed", json!({ "document": part.document, "detail": detail }));
  }
}

// One part written as the translator finished it, or as failed with why; once every part of this version stands,
// the rows of the document's other versions in this language go.
async fn save(
  stages: &Stages,
  part: &Part,
  text: Option<String>,
  failure: Option<String>,
) -> Result<(), sea_orm::DbErr> {
  let unit = stages.runs.db.begin().await?;

  run(
    &unit,
    r#"INSERT INTO "document_translations" ("document", "version", "target", "part", "parts", "text", "failed", "translated_at", "failure")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ("document", "target", "version", "part") DO UPDATE SET
         "parts" = excluded."parts", "text" = excluded."text", "failed" = excluded."failed", "translated_at" = excluded."translated_at",
         "failure" = excluded."failure""#,
    vec![
      part.document.clone().into(),
      part.version.clone().into(),
      part.target.clone().into(),
      part.part.into(),
      part.parts.into(),
      text.into(),
      i64::from(failure.is_some()).into(),
      now().into(),
      failure.into(),
    ],
  )
  .await?;

  let standing = one(
    &unit,
    r#"SELECT COUNT(*) AS "n" FROM "document_translations" WHERE "document" = $1 AND "target" = $2 AND "version" = $3"#,
    vec![part.document.clone().into(), part.target.clone().into(), part.version.clone().into()],
  )
  .await?
  .and_then(|row| row.try_get::<i64>("", "n").ok())
  .unwrap_or(0);

  if standing >= part.parts {
    run(
      &unit,
      r#"DELETE FROM "document_translations" WHERE "document" = $1 AND "target" = $2 AND "version" <> $3"#,
      vec![part.document.clone().into(), part.target.clone().into(), part.version.clone().into()],
    )
    .await?;
  }

  unit.commit().await?;

  Ok(())
}
