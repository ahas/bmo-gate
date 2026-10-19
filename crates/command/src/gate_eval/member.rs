//! One gate of the evaluation set (docs/gate-eval.md, 「The members」). Each gate answers this for itself in a
//! file of its own under `gates/`, its words in a data file of its own under the repository's `prompts/gate-eval/`;
//! nothing outside those knows what the gate is handed or how its answer is read. A member is written over its own
//! input and key; the set reads every member through `EvalGate`, which reads an item's JSON as the member's types
//! and refuses an item that does not read.

use std::sync::{Arc, LazyLock};

use futures_util::future::BoxFuture;
use gate_policy::fill_marks;
use gate_runs::GateRequest;
use gate_stages::Stages;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

/// A member's data file under the repository's `prompts/gate-eval/`, compiled in.
#[macro_export]
macro_rules! eval_words {
  ($file:literal) => {
    (
      $file,
      include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../prompts/gate-eval/", $file)),
    )
  };
}

/// A closed JSON schema, the form Codex enforces on an answer: every object names its properties, requires all
/// of them and allows no other.
pub mod schema {
  use serde_json::{Map, Value, json};

  pub fn text() -> Value {
    json!({ "type": "string" })
  }

  pub fn integer() -> Value {
    json!({ "type": "integer" })
  }

  pub fn boolean() -> Value {
    json!({ "type": "boolean" })
  }

  pub fn one_of(values: &[&str]) -> Value {
    json!({ "type": "string", "enum": values })
  }

  pub fn nullable_text() -> Value {
    json!({ "type": ["string", "null"] })
  }

  pub fn list(items: Value) -> Value {
    json!({ "type": "array", "items": items })
  }

  pub fn object(properties: &[(&str, Value)]) -> Value {
    let named: Map<String, Value> =
      properties.iter().map(|(name, value)| ((*name).to_owned(), value.clone())).collect();

    json!({
      "type": "object",
      "properties": named,
      "required": properties.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
      "additionalProperties": false,
    })
  }
}

/// The road a member's questions are asked on: one request in, the gate's answer or none out.
pub type Ask = Arc<dyn Fn(GateRequest) -> BoxFuture<'static, Option<String>> + Send + Sync>;

/// How one answer met its key: whether it came at all, whether it passed, and how many of the key's checks it
/// met, with the ones it missed named.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Score {
  pub answered: bool,
  pub pass: bool,
  pub met: usize,
  pub checks: usize,
  pub misses: Vec<String>,
  pub answer: Option<String>,
}

/// A gate of the set, written over its own input and key. Its prompts are read as the gate's run reads them, the
/// rulebooks through the agency the gates stand on.
pub trait Member: Send + Sync + 'static {
  type Input: DeserializeOwned + Send + Sync;
  type Key: DeserializeOwned + Send + Sync;

  /// The gate's work key, which its runs and its options stand under.
  fn stage(&self) -> &'static str;
  /// How many items the set is to hold.
  fn per_gate(&self) -> usize {
    300
  }
  /// How many items one batch asks for.
  fn batch_size(&self) -> usize;
  /// What the batches cycle through, so the set covers the gate's whole range.
  fn topics(&self) -> Vec<String>;
  fn input_schema(&self) -> Value;
  fn key_schema(&self) -> Value;
  /// What Codex is told about this gate: what it does, its real system prompt, an example request as the gate's
  /// code builds it, and what makes a question easy or borderline here.
  fn brief<'a>(&'a self, stages: &'a Stages) -> BoxFuture<'a, Result<String, String>>;
  /// Why an item cannot stand, or none where it can: an input the gate's code would not ask about, or a key that
  /// does not fit what the gate is shown.
  fn refusal(&self, input: &Self::Input, key: &Self::Key) -> Option<String>;
  /// The text two items are told apart by.
  fn fingerprint(&self, input: &Self::Input) -> String;
  /// The cases the member carries beside the set's items: inputs the gate answered wrongly in use, written by hand
  /// with their keys, asked in every scoring. None unless the member keeps some.
  fn cases(&self) -> Vec<EvalItem> {
    Vec::new()
  }
  /// The item asked on a road and its answer scored, read the way the gate's caller reads it.
  fn run<'a>(
    &'a self,
    stages: &'a Stages,
    input: &'a Self::Input,
    key: &'a Self::Key,
    ask: &'a Ask,
  ) -> BoxFuture<'a, Score>;
}

/// A gate of the set as the set reads it: over an item's JSON.
pub trait EvalGate: Send + Sync {
  fn stage(&self) -> &'static str;
  fn per_gate(&self) -> usize;
  fn batch_size(&self) -> usize;
  fn topics(&self) -> Vec<String>;
  fn input_schema(&self) -> Value;
  fn key_schema(&self) -> Value;
  fn brief<'a>(&'a self, stages: &'a Stages) -> BoxFuture<'a, Result<String, String>>;
  /// Why an item cannot stand, an item that does not read as the member's own included.
  fn refusal(&self, input: &Value, key: &Value) -> Option<String>;
  fn fingerprint(&self, input: &Value) -> String;
  fn cases(&self) -> Vec<EvalItem>;
  fn run<'a>(
    &'a self,
    stages: &'a Stages,
    input: &'a Value,
    key: &'a Value,
    ask: &'a Ask,
  ) -> BoxFuture<'a, Score>;
}

fn read<T: DeserializeOwned>(value: &Value) -> Result<T, String> {
  T::deserialize(value).map_err(|why| format!("unreadable item: {why}"))
}

impl<M: Member> EvalGate for M {
  fn stage(&self) -> &'static str {
    Member::stage(self)
  }

  fn per_gate(&self) -> usize {
    Member::per_gate(self)
  }

  fn batch_size(&self) -> usize {
    Member::batch_size(self)
  }

  fn topics(&self) -> Vec<String> {
    Member::topics(self)
  }

  fn input_schema(&self) -> Value {
    Member::input_schema(self)
  }

  fn key_schema(&self) -> Value {
    Member::key_schema(self)
  }

  fn brief<'a>(&'a self, stages: &'a Stages) -> BoxFuture<'a, Result<String, String>> {
    Member::brief(self, stages)
  }

  fn refusal(&self, input: &Value, key: &Value) -> Option<String> {
    match (read::<M::Input>(input), read::<M::Key>(key)) {
      (Ok(input), Ok(key)) => Member::refusal(self, &input, &key),
      (Err(why), _) | (_, Err(why)) => Some(why),
    }
  }

  fn fingerprint(&self, input: &Value) -> String {
    read::<M::Input>(input).map_or_else(|_| input.to_string(), |input| Member::fingerprint(self, &input))
  }

  fn cases(&self) -> Vec<EvalItem> {
    Member::cases(self)
  }

  fn run<'a>(
    &'a self,
    stages: &'a Stages,
    input: &'a Value,
    key: &'a Value,
    ask: &'a Ask,
  ) -> BoxFuture<'a, Score> {
    Box::pin(async move {
      match (read::<M::Input>(input), read::<M::Key>(key)) {
        (Ok(input), Ok(key)) => Member::run(self, stages, &input, &key, ask).await,
        (Err(why), _) | (_, Err(why)) => unanswered(None, &why),
      }
    })
  }
}

/// One member as it registers itself with the set.
pub struct Registered(pub &'static dyn EvalGate);

inventory::collect!(Registered);

/// One kept item of the set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EvalItem {
  pub id: String,
  pub gate: String,
  pub topic: String,
  pub difficulty: String,
  pub why: String,
  pub input: Value,
  pub key: Value,
}

/// A string the answer must carry, any of its accepted forms counting.
#[derive(Clone, Debug, Deserialize)]
pub struct Accepted {
  pub accept: Vec<String>,
}

pub fn accepted_schema() -> Value {
  schema::object(&[("accept", schema::list(schema::text()))])
}

/// Text compared the way a key is written: case, spacing and Unicode form set aside.
pub fn plain(text: &str) -> String {
  let lowered = text.nfc().collect::<String>().to_lowercase();

  lowered.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Text with no spacing at all, for readings a speaker says the same with or without a space.
pub fn unspaced(text: &str) -> String {
  plain(text).replace(' ', "")
}

/// The literal checks a key makes on an answer: every fact present in one of its forms, and none of the strings
/// it must not carry. A check is named in the misses by its first form.
#[derive(Debug, Default)]
pub struct Checks {
  met: usize,
  checks: usize,
  misses: Vec<String>,
}

impl Checks {
  pub fn check(&mut self, ok: bool, miss: impl Into<String>) {
    self.checks += 1;

    if ok {
      self.met += 1;
    } else {
      self.misses.push(miss.into());
    }
  }

  pub fn carries(&mut self, answer: &str, facts: &[Accepted]) {
    let said = plain(answer);

    for fact in facts {
      let found = fact.accept.iter().any(|form| said.contains(&plain(form)));

      self.check(found, format!("missing: {}", fact.accept.first().map_or("", String::as_str)));
    }
  }

  pub fn avoids(&mut self, answer: &str, strings: &[String]) {
    let said = plain(answer);

    for one in strings {
      self.check(!said.contains(&plain(one)), format!("carries: {one}"));
    }
  }

  pub fn score(self, answer: Option<&str>) -> Score {
    Score {
      answered: answer.is_some(),
      pass: self.misses.is_empty() && self.checks > 0,
      met: self.met,
      checks: self.checks,
      misses: self.misses,
      answer: answer.map(str::to_owned),
    }
  }
}

/// The score of a gate that gave no answer, or one its caller could not read.
pub fn unanswered(answer: Option<&str>, why: &str) -> Score {
  Score {
    answered: answer.is_some(),
    pass: false,
    met: 0,
    checks: 1,
    misses: vec![why.to_owned()],
    answer: answer.map(str::to_owned),
  }
}

/// How long an accepted form may be. A fact is matched literally, so a form is the distinctive word, name or
/// figure a faithful answer cannot do without; a phrase of several words matches only the one wording of it,
/// where a correct answer may word it another way.
pub const FORM_CHARS: usize = 20;
pub const FORM_WORDS: usize = 2;

// A key whose accepted forms are all empty is no key: it would match every answer.
fn empty_form(facts: &[Accepted]) -> bool {
  facts
    .iter()
    .any(|fact| fact.accept.is_empty() || fact.accept.iter().any(|form| plain(form).is_empty()))
}

/// Why a key's facts cannot be matched, or none where they can.
pub fn facts_fault(facts: &[Accepted]) -> Option<String> {
  if empty_form(facts) {
    return Some("an empty accepted form".to_owned());
  }

  let long = facts.iter().any(|fact| {
    fact.accept.iter().any(|form| {
      let form = form.trim();

      form.encode_utf16().count() > FORM_CHARS || form.split_whitespace().count() > FORM_WORDS
    })
  });

  long.then(|| "an accepted form too long to match".to_owned())
}

/// What every brief shows of a request: the system prompt and the prompt, as the gate is handed them.
pub fn shown_request(request: &GateRequest) -> String {
  [
    "SYSTEM PROMPT THE GATE IS GIVEN:",
    &request.system,
    "END OF SYSTEM PROMPT",
    "",
    "PROMPT THE GATE IS GIVEN (for the example input):",
    &request.prompt,
    "END OF PROMPT",
  ]
  .join("\n")
}

/// A member's own words, read from its data file: what its brief says around the gate's real prompts, the topics
/// its batches cycle through, and the example its brief shows. A file that does not read is a fault of the build,
/// which the member's own test meets.
pub fn words<T: DeserializeOwned>((file, text): (&str, &str)) -> T {
  toml::from_str(text).unwrap_or_else(|why| panic!("the gate-eval member's {file} does not read: {why}"))
}

#[derive(Deserialize)]
struct Shared {
  form_rule: String,
}

static SHARED: LazyLock<Shared> = LazyLock::new(|| words(crate::eval_words!("member.toml")));

/// The rule every brief gives for an accepted form, with its bound filled in.
pub fn form_rule() -> String {
  fill_marks(&SHARED.form_rule, &[("chars", &FORM_CHARS.to_string())])
}
