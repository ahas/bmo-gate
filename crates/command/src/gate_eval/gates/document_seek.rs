//! The document seeker (docs/gate-eval.md): an index and a question, answered with the entries to open, most
//! direct first. The seek runs as the document viewer runs it, a cut index asked again over its picks; the key
//! holds the slugs any of which is a right first pick, or none.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::future::BoxFuture;
use gate_stages::Stages;
use gate_stages::document_seek::{self, SeekEntry, is_slug, seek};
use serde::Deserialize;
use serde_json::Value;

use super::super::member::{
  Ask, Checks, Member, Registered, Score, schema, shown_request, unanswered, words,
};

/// The three kinds of index the seeker is handed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
  Headings,
  Documents,
  Branches,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Input {
  pub mode: Mode,
  pub entries: Vec<SeekEntry>,
  pub question: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Key {
  pub slugs: Vec<String>,
}

#[derive(Deserialize)]
struct Words {
  topics: Vec<String>,
  head: String,
  body: String,
  example: Input,
}

static WORDS: LazyLock<Words> = LazyLock::new(|| words(crate::eval_words!("document-seek.toml")));

// How many branches a branch index is answered with.
const BRANCH_PICKS: usize = 3;

fn system() -> Result<Arc<String>, String> {
  document_seek::system()
    .map(Arc::new)
    .ok_or_else(|| format!("{}: its instructions are not among the prompts", document_seek::STAGE))
}

pub struct DocumentSeek;

inventory::submit! { Registered(&DocumentSeek) }

impl Member for DocumentSeek {
  type Input = Input;
  type Key = Key;

  fn stage(&self) -> &'static str {
    document_seek::STAGE
  }

  fn batch_size(&self) -> usize {
    15
  }

  fn topics(&self) -> Vec<String> {
    WORDS.topics.clone()
  }

  fn input_schema(&self) -> Value {
    schema::object(&[
      ("mode", schema::one_of(&["headings", "documents", "branches"])),
      (
        "entries",
        schema::list(schema::object(&[
          ("slug", schema::text()),
          ("line", schema::text()),
          ("group", schema::nullable_text()),
        ])),
      ),
      ("question", schema::text()),
    ])
  }

  fn key_schema(&self) -> Value {
    schema::object(&[("slugs", schema::list(schema::text()))])
  }

  fn brief<'a>(&'a self, _: &'a Stages) -> BoxFuture<'a, Result<String, String>> {
    Box::pin(async move {
      let system = system()?;
      let example = &WORDS.example;
      let request = document_seek::request(&system, &example.entries, &example.question, None);

      Ok([WORDS.head.as_str(), "", &shown_request(&request), "", WORDS.body.trim()].join("\n"))
    })
  }

  fn refusal(&self, input: &Input, key: &Key) -> Option<String> {
    let slugs: Vec<&str> = input.entries.iter().map(|entry| entry.slug.as_str()).collect();
    let distinct: HashSet<&str> = slugs.iter().copied().collect();

    if input.entries.len() < 3 || slugs.iter().any(|slug| !is_slug(slug)) || distinct.len() != slugs.len() {
      return Some("an index of bad or repeated slugs".to_owned());
    }

    if key.slugs.iter().any(|slug| !distinct.contains(slug.as_str())) {
      return Some("a key slug not in the index".to_owned());
    }

    if input.mode == Mode::Branches && (key.slugs.is_empty() || input.entries.len() < BRANCH_PICKS) {
      return Some("a branch index answered none".to_owned());
    }

    None
  }

  fn fingerprint(&self, input: &Input) -> String {
    let lines: Vec<&str> = input.entries.iter().map(|entry| entry.line.as_str()).collect();

    format!("{}\n{}", input.question, lines.join("\n"))
  }

  fn run<'a>(
    &'a self,
    _: &'a Stages,
    input: &'a Input,
    key: &'a Key,
    ask: &'a Ask,
  ) -> BoxFuture<'a, Score> {
    Box::pin(async move {
      let Ok(system) = system() else {
        return unanswered(None, "no instructions to run on");
      };
      // The last answer the gate gave, which a pick that could not be read is scored with.
      let answer: Arc<Mutex<Option<String>>> = Arc::default();
      let picks = seek(&system, &input.entries, &input.question, |request| {
        let ask = Arc::clone(ask);
        let answer = Arc::clone(&answer);

        async move {
          let given = ask(request).await;

          answer.lock().expect("the seek's answer").clone_from(&given);
          given
        }
      })
      .await;
      let Some(picks) = picks else {
        return unanswered(answer.lock().expect("the seek's answer").as_deref(), "no readable pick");
      };
      let mut checks = Checks::default();
      let said = if picks.is_empty() { "none".to_owned() } else { picks.join("\n") };
      let first = picks.first().map_or("none", String::as_str);

      if key.slugs.is_empty() {
        checks.check(picks.is_empty(), format!("picked {first}, wanted none"));
      } else if input.mode == Mode::Branches {
        checks
          .check(picks.len() == BRANCH_PICKS, format!("{} branches, wanted {BRANCH_PICKS}", picks.len()));
        checks.check(
          picks.iter().any(|slug| key.slugs.contains(slug)),
          format!("missed {}", key.slugs.join("/")),
        );
      } else {
        checks.check(
          picks.first().is_some_and(|slug| key.slugs.contains(slug)),
          format!("first {first}, wanted {}", key.slugs.join("/")),
        );
      }

      checks.score(Some(&said))
    })
  }
}
