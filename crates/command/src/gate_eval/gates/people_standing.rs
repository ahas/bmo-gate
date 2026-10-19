//! The standing-sheet summariser (docs/gate-eval.md): the pieces of one part of one person's book, handed over as
//! the brain hands them, and the sheet it writes. The summariser's own check decides whether the sheet may stand at
//! all; the key holds the facts it must keep and what it must leave in the pieces.

use std::sync::LazyLock;

use futures_util::future::BoxFuture;
use gate_markup::js;
use gate_policy::fill_marks;
use gate_runs::GateRequest;
use gate_stages::Stages;
use gate_stages::sheets::{self, Part, Piece as SheetPiece, SheetAsk, sheet_problem, standing_prompt};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use super::super::member::{
  Accepted, Ask, Checks, Member, Registered, Score, accepted_schema, facts_fault, form_rule, schema,
  shown_request, unanswered, words,
};

#[derive(Clone, Debug, Deserialize)]
pub struct Piece {
  pub slug: String,
  pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
  pub layer: Part,
  pub chat_id: i64,
  pub user_id: i64,
  pub pieces: Vec<Piece>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Key {
  pub facts: Vec<Accepted>,
  pub avoid: Vec<String>,
}

// Where a piece of each part stands in the brain, and the most a sheet of it may hold, as the brain hands them.
#[derive(Deserialize)]
struct ByPart<T> {
  common: T,
  room: T,
}

impl<T> ByPart<T> {
  fn of(&self, part: Part) -> &T {
    match part {
      Part::Common => &self.common,
      Part::Room => &self.room,
    }
  }
}

#[derive(Deserialize)]
struct Words {
  topics: Vec<String>,
  head: String,
  body: String,
  example: Input,
  paths: ByPart<String>,
  ceilings: ByPart<usize>,
}

static WORDS: LazyLock<Words> = LazyLock::new(|| words(crate::eval_words!("people-standing.toml")));

// A piece's slug in each part, naming the person it is about.
static COMMON_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^c(\d+)-[a-z0-9-]+$").expect("a slug"));
static ROOM_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^p(\d+)-[a-z0-9-]+$").expect("a slug"));

// The pieces as the brain hands them, each under the path it stands at, which is what the summariser is shown.
fn pieces_of(input: &Input) -> Vec<SheetPiece> {
  input
    .pieces
    .iter()
    .map(|piece| SheetPiece {
      path: fill_marks(
        WORDS.paths.of(input.layer),
        &[
          ("person", &input.user_id.to_string()),
          ("chat", &input.chat_id.to_string()),
          ("slug", &piece.slug),
        ],
      ),
      text: piece.text.clone(),
    })
    .collect()
}

// The ask the brain would make of the summariser for the input, as the chat agent's.
fn ask_of(stages: &Stages, input: &Input) -> SheetAsk {
  SheetAsk {
    agent: stages.runs.chat_agent.clone(),
    part: input.layer,
    chat_id: (input.layer == Part::Room).then_some(input.chat_id),
    person: input.user_id,
    pieces: pieces_of(input),
    ceiling: *WORDS.ceilings.of(input.layer),
    registration: None,
  }
}

async fn standing_request(stages: &Stages, input: &Input) -> Result<GateRequest, String> {
  let system = sheets::system(stages).await.map_err(|why| why.to_string())?;

  Ok(GateRequest::new(system, standing_prompt(&ask_of(stages, input))))
}

pub struct PeopleStanding;

inventory::submit! { Registered(&PeopleStanding) }

impl Member for PeopleStanding {
  type Input = Input;
  type Key = Key;

  fn stage(&self) -> &'static str {
    sheets::STAGE
  }

  fn batch_size(&self) -> usize {
    6
  }

  fn topics(&self) -> Vec<String> {
    WORDS.topics.clone()
  }

  fn input_schema(&self) -> Value {
    schema::object(&[
      ("layer", schema::one_of(&["common", "room"])),
      ("chatId", schema::integer()),
      ("userId", schema::integer()),
      (
        "pieces",
        schema::list(schema::object(&[("slug", schema::text()), ("text", schema::text())])),
      ),
    ])
  }

  fn key_schema(&self) -> Value {
    schema::object(&[("facts", schema::list(accepted_schema())), ("avoid", schema::list(schema::text()))])
  }

  fn brief<'a>(&'a self, stages: &'a Stages) -> BoxFuture<'a, Result<String, String>> {
    Box::pin(async move {
      let request = standing_request(stages, &WORDS.example).await?;
      let body = fill_marks(WORDS.body.trim(), &[("form_rule", &form_rule())]);

      Ok([WORDS.head.as_str(), "", &shown_request(&request), "", &body].join("\n"))
    })
  }

  fn refusal(&self, input: &Input, key: &Key) -> Option<String> {
    let pattern = match input.layer {
      Part::Common => &COMMON_SLUG,
      Part::Room => &ROOM_SLUG,
    };
    let person = input.user_id.to_string();
    let others = input.pieces.iter().any(|piece| {
      pattern.captures(&piece.slug).and_then(|found| found.get(1)).map(|id| id.as_str())
        != Some(person.as_str())
    });

    if input.pieces.is_empty() || others {
      return Some("a piece slug that is not this person's part".to_owned());
    }

    if key.facts.is_empty() {
      Some("no facts to keep".to_owned())
    } else {
      facts_fault(&key.facts)
    }
  }

  fn fingerprint(&self, input: &Input) -> String {
    input.pieces.iter().map(|piece| piece.text.as_str()).collect::<Vec<_>>().join("\n")
  }

  fn run<'a>(
    &'a self,
    stages: &'a Stages,
    input: &'a Input,
    key: &'a Key,
    ask: &'a Ask,
  ) -> BoxFuture<'a, Score> {
    Box::pin(async move {
      let Ok(request) = standing_request(stages, input).await else {
        return unanswered(None, "no instructions to run on");
      };
      let Some(answer) = ask(request).await else {
        return unanswered(None, "no answer");
      };
      let sheet = js::trim(&answer);
      let asked = ask_of(stages, input);

      if let Some(problem) = sheet_problem(input.layer, asked.ceiling, sheet, &asked.pieces) {
        return unanswered(Some(&answer), &problem);
      }

      let mut checks = Checks::default();

      checks.carries(sheet, &key.facts);
      checks.avoids(sheet, &key.avoid);
      checks.score(Some(&answer))
    })
  }
}
