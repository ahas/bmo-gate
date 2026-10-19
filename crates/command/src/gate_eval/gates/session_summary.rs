//! The session summariser (docs/gate-eval.md): the tail of a session about to be replaced, made into the
//! transcript by the gate's own code out of the turns the session held, and the note it writes. The key holds the
//! facts the note must carry, the strings it must not, or that there is nothing to carry.

use std::sync::LazyLock;

use futures_util::future::BoxFuture;
use gate_markup::js;
use gate_policy::fill_marks;
use gate_policy::handover::HANDOVER;
use gate_runs::GateRequest;
use gate_runs::summary::{self, Kind, Turn as Recorded, agent_name, transcript_text};
use gate_stages::Stages;
use serde::Deserialize;
use serde_json::Value;

use super::super::member::{
  Accepted, Ask, Checks, Member, Registered, Score, accepted_schema, facts_fault, form_rule, schema,
  shown_request, unanswered, words,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
  Chat,
  Worker,
}

impl SessionKind {
  fn kind(self) -> Kind {
    match self {
      Self::Chat => Kind::Chat,
      Self::Worker => Kind::Worker,
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Who {
  Room,
  Agent,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Turn {
  pub who: Who,
  pub room: Option<String>,
  pub lines: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Input {
  pub kind: SessionKind,
  pub turns: Vec<Turn>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Key {
  pub none: bool,
  pub facts: Vec<Accepted>,
  pub avoid: Vec<String>,
}

#[derive(Deserialize)]
struct Words {
  topics: Vec<String>,
  head: String,
  body: String,
  example: Input,
}

static WORDS: LazyLock<Words> = LazyLock::new(|| words(crate::eval_words!("session-summary.toml")));

// One turn as the session record holds it: a room's turn is the whole round prompt, of which the transcript keeps
// the room's own messages; the agent's is its answer.
fn recorded(turn: &Turn) -> Recorded {
  if turn.who == Who::Agent {
    return Recorded {
      assistant: true,
      text: turn.lines.join("\n"),
    };
  }

  let mut text: Vec<String> =
    turn.room.iter().flat_map(|room| [format!("Chat id: {room}"), String::new()]).collect();

  text.push(format!("New messages ({}):", turn.lines.len()));
  text.extend(turn.lines.iter().cloned());
  text.push("END OF NEW MESSAGES".to_owned());

  Recorded {
    assistant: false,
    text: text.join("\n"),
  }
}

/// The transcript the summariser is handed for an input, the chat agent named as `agent`.
pub fn transcript(input: &Input, agent: &str) -> String {
  transcript_text(
    &input.turns.iter().map(recorded).collect::<Vec<_>>(),
    agent,
    HANDOVER.transcript_tail_chars,
  )
}

async fn system(stages: &Stages, kind: Kind, agent: &str) -> Result<String, String> {
  summary::system(&stages.runs, kind, agent).await.map_err(|why| why.to_string())
}

async fn summary_request(stages: &Stages, input: &Input) -> Result<GateRequest, String> {
  let agent = agent_name(&stages.runs).await;

  Ok(GateRequest::new(
    system(stages, input.kind.kind(), &agent).await?,
    format!("{}\n{}", HANDOVER.summary_heading, transcript(input, &agent)),
  ))
}

pub struct SessionSummary;

inventory::submit! { Registered(&SessionSummary) }

impl Member for SessionSummary {
  type Input = Input;
  type Key = Key;

  fn stage(&self) -> &'static str {
    summary::STAGE
  }

  fn batch_size(&self) -> usize {
    8
  }

  fn topics(&self) -> Vec<String> {
    WORDS.topics.clone()
  }

  fn input_schema(&self) -> Value {
    schema::object(&[
      ("kind", schema::one_of(&["chat", "worker"])),
      (
        "turns",
        schema::list(schema::object(&[
          ("who", schema::one_of(&["room", "agent"])),
          ("room", schema::nullable_text()),
          ("lines", schema::list(schema::text())),
        ])),
      ),
    ])
  }

  fn key_schema(&self) -> Value {
    schema::object(&[
      ("none", schema::boolean()),
      ("facts", schema::list(accepted_schema())),
      ("avoid", schema::list(schema::text())),
    ])
  }

  fn brief<'a>(&'a self, stages: &'a Stages) -> BoxFuture<'a, Result<String, String>> {
    Box::pin(async move {
      let request = summary_request(stages, &WORDS.example).await?;
      let worker = system(stages, Kind::Worker, &agent_name(&stages.runs).await).await?;
      let body = fill_marks(WORDS.body.trim(), &[("form_rule", &form_rule())]);

      Ok(
        [
          WORDS.head.as_str(),
          "",
          &shown_request(&request),
          "",
          "WORKER INSTRUCTIONS:",
          &worker,
          "",
          &body,
        ]
        .join("\n"),
      )
    })
  }

  fn refusal(&self, input: &Input, key: &Key) -> Option<String> {
    if input.turns.is_empty() || input.turns.iter().any(|turn| turn.lines.is_empty()) {
      return Some("an empty turn".to_owned());
    }

    if input.kind == SessionKind::Worker && input.turns.iter().any(|turn| turn.who == Who::Room) {
      return Some("a room turn in a worker session".to_owned());
    }

    if key.none != key.facts.is_empty() {
      return Some("a key that neither carries nor is none".to_owned());
    }

    if let Some(fault) = facts_fault(&key.facts) {
      return Some(fault);
    }

    // The agent's name is no part of whether there is a transcript, so any name reads it.
    transcript(input, "agent").is_empty().then(|| "an empty transcript".to_owned())
  }

  fn fingerprint(&self, input: &Input) -> String {
    input.turns.iter().map(|turn| turn.lines.join("\n")).collect::<Vec<_>>().join("\n")
  }

  fn run<'a>(
    &'a self,
    stages: &'a Stages,
    input: &'a Input,
    key: &'a Key,
    ask: &'a Ask,
  ) -> BoxFuture<'a, Score> {
    Box::pin(async move {
      let Ok(request) = summary_request(stages, input).await else {
        return unanswered(None, "no instructions to run on");
      };
      let Some(answer) = ask(request).await else {
        return unanswered(None, "no answer");
      };
      let note = js::trim(&answer);
      let nothing = note.is_empty() || note.eq_ignore_ascii_case("none");
      let mut checks = Checks::default();

      if key.none {
        checks.check(nothing, "carried something, wanted none");

        return checks.score(Some(&answer));
      }

      let cap = HANDOVER.summary_char_cap;
      let length = js::units(note);

      checks.check(!nothing, "said none");
      checks.check(length <= cap, format!("{length} characters, over {cap}"));
      checks.carries(note, &key.facts);
      checks.avoids(note, &key.avoid);
      checks.score(Some(&answer))
    })
  }
}
