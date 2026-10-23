//! The translator (docs/gate-eval.md): one part of a text under one of its three instructions. The translator's
//! own reading decides whether the answer stands (its structure kept); the key holds what must come through
//! unchanged, the phrases with their accepted renderings, and what must not appear. Its cases are inputs it
//! answered with words of its own in place of a translation in use.

use std::sync::{Arc, LazyLock};

use futures_util::future::BoxFuture;
use gate_policy::{fill_marks, prompts};
use gate_stages::Stages;
use gate_stages::document_translation::{Kept, Outcome, request, translate_part};
use gate_stages::records::{record_system, worker_system};
use gate_stages::translator::STAGE;
use serde::Deserialize;
use serde_json::Value;

use super::super::member::{
  Accepted, Ask, Checks, EvalItem, Member, Registered, Score, facts_fault, form_rule, schema,
  shown_request, unanswered, words,
};

/// The translator's three instructions: the document viewer's, a worker's text into English, and a worker's
/// record into Korean.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Variant {
  Viewer,
  Worker,
  Record,
}

impl Variant {
  fn name(self) -> &'static str {
    match self {
      Self::Viewer => "viewer",
      Self::Worker => "worker",
      Self::Record => "record",
    }
  }

  // The one language the instructions translate into, where they have only one.
  fn target(self) -> Option<&'static str> {
    match self {
      Self::Viewer => None,
      Self::Worker => Some("en"),
      Self::Record => Some("ko"),
    }
  }

  // What of its part's structure an answer must keep under these instructions, as their caller reads it.
  fn kept(self) -> Kept {
    match self {
      Self::Viewer | Self::Worker => Kept::Whole,
      Self::Record => Kept::Headings,
    }
  }

  async fn system(self, stages: &Stages) -> Result<String, String> {
    let missing = |file: &str| format!("{STAGE}/{file} is not among the prompts");

    match self {
      Self::Viewer => prompts::instructions(STAGE)
        .map(str::to_owned)
        .ok_or_else(|| missing("instructions.md")),
      Self::Worker => worker_system().map(str::to_owned).ok_or_else(|| missing("worker.md")),
      Self::Record => record_system(stages).await.map_err(|why| why.to_string()),
    }
  }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Input {
  pub variant: Variant,
  pub target: String,
  pub text: String,
}

/// A phrase of the source with the renderings a correct translation would contain, read by its renderings alone.
#[derive(Clone, Debug, Deserialize)]
pub struct Rendered {
  pub accept: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Key {
  pub keep: Vec<String>,
  pub render: Vec<Rendered>,
  pub avoid: Vec<String>,
}

#[derive(Deserialize)]
struct Words {
  topics: Vec<String>,
  head: String,
  viewer: String,
  worker: String,
  record: String,
  example_head: String,
  body: String,
  example: Input,
  cases: Vec<Case>,
}

// A case as its data file writes it, read as the set's items are.
#[derive(Deserialize)]
struct Case {
  topic: String,
  why: String,
  input: Value,
  key: Value,
}

static WORDS: LazyLock<Words> = LazyLock::new(|| words(crate::eval_words!("translator.toml")));

fn renderings(key: &Key) -> Vec<Accepted> {
  key
    .render
    .iter()
    .map(|one| Accepted {
      accept: one.accept.clone(),
    })
    .collect()
}

pub struct Translator;

inventory::submit! { Registered(&Translator) }

impl Member for Translator {
  type Input = Input;
  type Key = Key;

  fn stage(&self) -> &'static str {
    STAGE
  }

  fn batch_size(&self) -> usize {
    12
  }

  fn topics(&self) -> Vec<String> {
    WORDS.topics.clone()
  }

  fn input_schema(&self) -> Value {
    schema::object(&[
      ("variant", schema::one_of(&["viewer", "worker", "record"])),
      ("target", schema::one_of(&["ko", "en"])),
      ("text", schema::text()),
    ])
  }

  fn key_schema(&self) -> Value {
    schema::object(&[
      ("keep", schema::list(schema::text())),
      (
        "render",
        schema::list(schema::object(&[
          ("source", schema::text()),
          ("accept", schema::list(schema::text())),
        ])),
      ),
      ("avoid", schema::list(schema::text())),
    ])
  }

  fn brief<'a>(&'a self, stages: &'a Stages) -> BoxFuture<'a, Result<String, String>> {
    Box::pin(async move {
      let worker = Arc::new(Variant::Worker.system(stages).await?);
      let example = &WORDS.example;
      let shown = shown_request(&request(&example.text, "en", &worker));
      let body = fill_marks(WORDS.body.trim(), &[("form_rule", &form_rule())]);

      Ok(
        [
          WORDS.head.as_str(),
          "",
          &WORDS.viewer,
          &Variant::Viewer.system(stages).await?,
          "",
          &WORDS.worker,
          &worker,
          "",
          &WORDS.record,
          &Variant::Record.system(stages).await?,
          "",
          &WORDS.example_head,
          &shown,
          "",
          &body,
        ]
        .join("\n"),
      )
    })
  }

  fn refusal(&self, input: &Input, key: &Key) -> Option<String> {
    if let Some(target) = input.variant.target().filter(|target| *target != input.target) {
      return Some(format!("{} translates into {target} only", input.variant.name()));
    }

    if let Some(missing) = key.keep.iter().find(|one| !input.text.contains(one.as_str())) {
      return Some(format!("kept string not in the source: {missing}"));
    }

    if key.keep.is_empty() && key.render.is_empty() {
      return Some("no key".to_owned());
    }

    facts_fault(&renderings(key))
  }

  fn fingerprint(&self, input: &Input) -> String {
    input.text.clone()
  }

  fn cases(&self) -> Vec<EvalItem> {
    WORDS
      .cases
      .iter()
      .enumerate()
      .map(|(at, case)| EvalItem {
        id: format!("{STAGE}-case-{:04}", at + 1),
        gate: STAGE.to_owned(),
        topic: case.topic.clone(),
        difficulty: "borderline".to_owned(),
        why: case.why.clone(),
        input: case.input.clone(),
        key: case.key.clone(),
      })
      .collect()
  }

  fn run<'a>(
    &'a self,
    stages: &'a Stages,
    input: &'a Input,
    key: &'a Key,
    ask: &'a Ask,
  ) -> BoxFuture<'a, Score> {
    Box::pin(async move {
      let Ok(system) = input.variant.system(stages).await.map(Arc::new) else {
        return unanswered(None, "no instructions to run on");
      };
      let outcome =
        translate_part(&input.text, &input.target, &system, input.variant.kept(), |request| ask(request))
          .await;
      // A mismatch is an answer that lost the part's structure twice; the translation itself is not kept.
      let text = match outcome {
        Outcome::Translated(text) => text,
        Outcome::Mismatch(lost) => return unanswered(Some(""), &format!("structure changed: {lost}")),
        Outcome::Unanswered => return unanswered(None, "no answer"),
      };
      let mut checks = Checks::default();

      for one in &key.keep {
        checks.check(text.contains(one.as_str()), format!("changed: {one}"));
      }

      checks.carries(&text, &renderings(key));
      checks.avoids(&text, &key.avoid);
      checks.score(Some(&text))
    })
  }
}
