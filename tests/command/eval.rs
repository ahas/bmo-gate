//! The evaluation set's machinery: the records a set keeps, Codex's event stream and command, a gate's generation
//! on a scripted Codex — items kept, dropped by reason, refusals counted, a stop taken up after, a thread resumed
//! and opened afresh — and a scoring run on a registration with its figures and report.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use futures_util::future::BoxFuture;
use gate_command::gate_eval::codex::{CodexReading, CodexRun, codex_command, read_codex_events};
use gate_command::gate_eval::generate::{
  Generation, POLICY_FAILURE, REFUSAL_WORDS, generate_gate, reason_of,
};
use gate_command::gate_eval::member::{
  Accepted, Ask, Checks, EvalItem, Member, Score, facts_fault, plain, schema, unspaced,
};
use gate_command::gate_eval::score::{
  Road, ScoreLine, Scoring, figures_of, latest_figures, score_set, spread,
};
use gate_command::gate_eval::store::{
  BatchRecord, GateState, gate_batches, gate_items, gate_state, set_folder,
};
use gate_command::gate_eval::{GateEvalArgs, report, road_of, unit_words};
use gate_stages::Stages;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::fakes::completion;
use crate::{Ground, ground};

#[test]
fn text_is_compared_with_case_spacing_and_form_set_aside() {
  assert_eq!(plain("  Roll   BACK\n"), "roll back");
  assert_eq!(unspaced("Roll back"), "rollback");
  assert_eq!(plain("e\u{301}"), "\u{e9}");
}

#[test]
fn a_key_is_held_to_short_non_empty_forms() {
  let fact = |forms: &[&str]| Accepted {
    accept: forms.iter().map(|form| (*form).to_owned()).collect(),
  };

  assert_eq!(facts_fault(&[fact(&["rollback", "roll back"])]), None);
  assert_eq!(facts_fault(&[fact(&[" "])]).as_deref(), Some("an empty accepted form"));
  assert_eq!(facts_fault(&[fact(&[])]).as_deref(), Some("an empty accepted form"));
  assert_eq!(
    facts_fault(&[fact(&["one two three"])]).as_deref(),
    Some("an accepted form too long to match")
  );
}

#[test]
fn checks_pass_only_where_every_check_is_met() {
  let mut checks = Checks::default();

  checks.carries(
    "The Deploy rolled back",
    &[Accepted {
      accept: vec!["rolled back".to_owned()],
    }],
  );
  checks.avoids("The Deploy rolled back", &["deploy".to_owned()]);

  let score = checks.score(Some("x"));

  assert_eq!((score.pass, score.met, score.checks), (false, 1, 2));
  assert_eq!(score.misses, ["carries: deploy"]);
  assert!(!Checks::default().score(None).pass);
}

#[test]
fn a_record_written_before_a_field_stood_still_reads() {
  let batch: BatchRecord =
    serde_json::from_str(r#"{"batch":0,"topic":"t","asked":15,"kept":15,"dropped":{}}"#).unwrap();
  let state: GateState = serde_json::from_str(r#"{"status":"done","wanted":300}"#).unwrap();

  assert_eq!((batch.asked, batch.examples.len(), batch.failure), (15, 0, None));
  assert_eq!((state.status.as_str(), state.wanted, state.batches), ("done", Some(300), 0));
}

#[test]
fn a_set_named_by_an_absolute_path_is_that_folder() {
  assert_eq!(set_folder(Path::new("/data"), "v1"), Path::new("/data/gate-eval/v1"));
  assert_eq!(set_folder(Path::new("/data"), "/elsewhere"), Path::new("/elsewhere"));
}

#[test]
fn codex_s_stream_gives_the_thread_the_answer_the_usage_and_a_failed_turn() {
  let stream = [
    "Reading prompt from stdin...".to_owned(),
    json!({ "type": "thread.started", "thread_id": "abc" }).to_string(),
    json!({ "type": "item.completed", "item": { "type": "error", "text": "notice" } }).to_string(),
    json!({ "type": "item.completed", "item": { "type": "agent_message", "text": "{\"items\":[]}" } }).to_string(),
    json!({ "type": "turn.completed", "usage": { "input_tokens": 100, "cached_input_tokens": 60, "output_tokens": 7, "reasoning_output_tokens": 3 } }).to_string(),
  ]
  .join("\n");

  assert_eq!(
    read_codex_events(&stream),
    CodexReading {
      thread: Some("abc".to_owned()),
      text: "{\"items\":[]}".to_owned(),
      input_tokens: 100,
      cached_tokens: 60,
      output_tokens: 10,
      failure: None,
    }
  );
  assert_eq!(
    read_codex_events(&json!({ "type": "turn.failed", "error": { "message": "usage limit" } }).to_string())
      .failure
      .as_deref(),
    Some("usage limit")
  );
}

#[test]
fn a_batch_names_its_model_effort_and_schema_and_resumes_the_thread_it_continues() {
  let command = codex_command(Some("t1"), Path::new("/s/x.json"));

  assert_eq!(&command[..4], ["codex", "exec", "resume", "t1"]);
  assert!(command.windows(2).any(|pair| pair == ["-m", "gpt-5.6-terra"]));
  assert!(command.windows(2).any(|pair| pair == ["--output-schema", "/s/x.json"]));
  assert_eq!(command.last().map(String::as_str), Some("-"));
  assert!(!codex_command(None, Path::new("/s")).contains(&"resume".to_owned()));
}

#[test]
fn a_drop_is_counted_under_its_words_up_to_the_colon_of_its_last_line() {
  assert_eq!(reason_of("kept string not in the source: x"), "kept string not in the source");
  assert_eq!(reason_of("duplicate"), "duplicate");
  assert_eq!(reason_of("a: b\nc: d"), "a: b\nc");
}

#[test]
fn a_refusal_is_read_in_a_failure_or_in_the_answer_s_words() {
  assert!(POLICY_FAILURE.is_match("This request violates our usage policy"));
  assert!(!POLICY_FAILURE.is_match("usage limit reached"));
  assert!(REFUSAL_WORDS.is_match("I can't help with that"));
  assert!(REFUSAL_WORDS.is_match("\u{C8C4}\u{C1A1}\u{D569}\u{B2C8}\u{B2E4}"));
  assert!(!REFUSAL_WORDS.is_match("{\"items\": []}"));
}

#[derive(Deserialize)]
struct Text {
  text: String,
}

#[derive(Deserialize)]
struct Word {
  word: String,
}

// A gate whose key is a word its text must hold, told what its brief says and which word it refuses.
struct Echo {
  stage: &'static str,
  brief: &'static str,
  refused: Option<&'static str>,
}

const ECHO: Echo = Echo {
  stage: "echo",
  brief: "THE GATE: echo",
  refused: None,
};

impl Member for Echo {
  type Input = Text;
  type Key = Word;

  fn stage(&self) -> &'static str {
    self.stage
  }

  fn per_gate(&self) -> usize {
    3
  }

  fn batch_size(&self) -> usize {
    2
  }

  fn topics(&self) -> Vec<String> {
    vec!["one".to_owned(), "two".to_owned()]
  }

  fn input_schema(&self) -> Value {
    schema::object(&[("text", schema::text())])
  }

  fn key_schema(&self) -> Value {
    schema::object(&[("word", schema::text())])
  }

  fn brief<'a>(&'a self, _: &'a Stages) -> BoxFuture<'a, Result<String, String>> {
    Box::pin(async move { Ok(self.brief.to_owned()) })
  }

  fn refusal(&self, input: &Text, key: &Word) -> Option<String> {
    if self.refused == Some(key.word.as_str()) {
      return Some(format!("no {}s", key.word));
    }

    (!input.text.contains(&key.word)).then(|| "key not in text".to_owned())
  }

  fn fingerprint(&self, input: &Text) -> String {
    input.text.clone()
  }

  fn run<'a>(
    &'a self,
    _: &'a Stages,
    input: &'a Text,
    key: &'a Word,
    ask: &'a Ask,
  ) -> BoxFuture<'a, Score> {
    Box::pin(async move {
      let answer = ask(gate_runs::GateRequest::new("ECHO", input.text.clone())).await;
      let mut checks = Checks::default();

      checks.check(
        answer.as_deref().is_some_and(|answer| answer.contains(&key.word)),
        format!("missing: {}", key.word),
      );
      checks.score(answer.as_deref())
    })
  }
}

fn answered(items: Value, thread: &str) -> CodexReading {
  CodexReading {
    thread: Some(thread.to_owned()),
    text: json!({ "items": items }).to_string(),
    input_tokens: 10,
    cached_tokens: 5,
    output_tokens: 3,
    failure: None,
  }
}

fn failed(failure: &str) -> CodexReading {
  CodexReading {
    failure: Some(failure.to_owned()),
    ..CodexReading::default()
  }
}

fn item(text: &str, word: &str) -> Value {
  json!({ "difficulty": "easy", "why": "because", "input": { "text": text }, "key": { "word": word } })
}

// A Codex that answers each batch from a script and notes the thread and prompt it was handed.
struct Scripted {
  answers: Mutex<Vec<CodexReading>>,
  calls: Mutex<Vec<(Option<String>, String)>>,
}

impl Scripted {
  fn new(answers: Vec<CodexReading>) -> Self {
    Self {
      answers: Mutex::new(answers),
      calls: Mutex::default(),
    }
  }

  fn threads(&self) -> Vec<Option<String>> {
    self.calls.lock().unwrap().iter().map(|(thread, _)| thread.clone()).collect()
  }

  fn prompt(&self, at: usize) -> String {
    self.calls.lock().unwrap()[at].1.clone()
  }
}

impl CodexRun for Scripted {
  fn schema_file(&self, _: &str, _: &Value) -> Result<PathBuf, String> {
    Ok(PathBuf::from("/dev/null"))
  }

  fn run<'a>(
    &'a self,
    thread: Option<&'a str>,
    _: &'a Path,
    prompt: &'a str,
  ) -> BoxFuture<'a, CodexReading> {
    self.calls.lock().unwrap().push((thread.map(str::to_owned), prompt.to_owned()));

    let mut answers = self.answers.lock().unwrap();
    let next = if answers.is_empty() { failed("no more answers") } else { answers.remove(0) };

    Box::pin(async move { next })
  }
}

async fn generate(ground: &Ground, member: &Echo, codex: &Scripted, per_gate: Option<usize>) -> GateState {
  let given = Generation {
    data_root: &ground.data_root,
    set: "v1",
    per_gate,
    batch: None,
    codex,
    stages: &ground.stages,
    log: &|_| {},
  };

  generate_gate(member, &given).await.unwrap()
}

fn texts(items: &[EvalItem]) -> Vec<Value> {
  items.iter().map(|item| item.input["text"].clone()).collect()
}

#[tokio::test]
async fn a_generation_keeps_what_its_member_accepts_drops_the_rest_by_reason_and_resumes_its_thread() {
  let ground = ground("generate-keeps").await;
  let codex = Scripted::new(vec![
    answered(json!([item("a cat", "cat"), item("no word", "dog"), item("a cat", "cat")]), "t1"),
    answered(json!([item("a dog", "dog"), item("a bird", "bird")]), "t1"),
  ]);
  let state = generate(&ground, &ECHO, &codex, None).await;
  let dropped: Vec<(usize, Vec<(String, usize)>)> = gate_batches(&ground.data_root, "v1", "echo")
    .unwrap()
    .into_iter()
    .map(|batch| (batch.kept, batch.dropped.into_iter().collect()))
    .collect();

  assert_eq!(state.status, "done");
  assert_eq!(
    texts(&gate_items(&ground.data_root, "v1", "echo").unwrap()),
    ["a cat", "a dog", "a bird"]
  );
  assert_eq!(
    dropped,
    [(1, vec![("duplicate".to_owned(), 1), ("key not in text".to_owned(), 1)]), (2, vec![])]
  );
  assert_eq!(codex.threads(), [None, Some("t1".to_owned())]);
  assert!(codex.prompt(0).contains("THE GATE: echo"));
  assert!(
    codex
      .prompt(0)
      .starts_with("You are writing an evaluation set for one gate of a chat assistant")
  );
  assert!(!codex.prompt(1).contains("THE GATE: echo"));
}

#[tokio::test]
async fn refused_batches_are_counted_and_three_in_a_row_leave_the_gate() {
  let ground = ground("generate-refused").await;
  let codex = Scripted::new(vec![
    failed("This request violates our usage policy"),
    failed("usage policy"),
    failed("usage policy"),
  ]);
  let state = generate(&ground, &ECHO, &codex, None).await;
  let refused: Vec<usize> = gate_batches(&ground.data_root, "v1", "echo")
    .unwrap()
    .iter()
    .map(|batch| batch.refused)
    .collect();

  assert_eq!(state.status, "refused");
  assert_eq!(refused, [2, 2, 2]);
  assert!(gate_items(&ground.data_root, "v1", "echo").unwrap().is_empty());
}

#[tokio::test]
async fn any_other_failure_stops_the_gate_and_the_next_run_takes_up_after_it() {
  let ground = ground("generate-stops").await;
  let first =
    Scripted::new(vec![answered(json!([item("a cat", "cat")]), "t1"), failed("usage limit reached")]);
  let stopped = generate(&ground, &ECHO, &first, None).await;

  assert_eq!(
    (stopped.status.as_str(), stopped.reason.as_deref(), stopped.batches),
    ("stopped", Some("usage limit reached"), 1)
  );

  let second = Scripted::new(vec![answered(json!([item("a dog", "dog"), item("a bird", "bird")]), "t2")]);
  let done = generate(&ground, &ECHO, &second, None).await;
  let ids: Vec<String> = gate_items(&ground.data_root, "v1", "echo")
    .unwrap()
    .into_iter()
    .map(|item| item.id)
    .collect();

  assert_eq!(done.status, "done");
  assert_eq!(second.threads(), [Some("t1".to_owned())]);
  assert_eq!(gate_state(&ground.data_root, "v1", "echo").batches, 2);
  assert_eq!(ids, ["echo-0001", "echo-0002", "echo-0003"]);
}

#[tokio::test]
async fn a_kept_item_its_member_now_refuses_leaves_and_its_id_is_never_given_again() {
  let ground = ground("generate-tightened").await;

  generate(
    &ground,
    &ECHO,
    &Scripted::new(vec![answered(json!([item("a cat", "cat"), item("a fox", "fox")]), "t1")]),
    Some(2),
  )
  .await;

  let stricter = Echo {
    refused: Some("fox"),
    ..ECHO
  };

  generate(
    &ground,
    &stricter,
    &Scripted::new(vec![answered(json!([item("a dog", "dog")]), "t2")]),
    Some(2),
  )
  .await;

  let kept: Vec<(String, Value)> = gate_items(&ground.data_root, "v1", "echo")
    .unwrap()
    .into_iter()
    .map(|item| (item.id, item.input["text"].clone()))
    .collect();

  assert_eq!(
    kept,
    [("echo-0001".to_owned(), json!("a cat")), ("echo-0003".to_owned(), json!("a dog"))]
  );
}

#[tokio::test]
async fn a_changed_brief_opens_a_new_thread() {
  let ground = ground("generate-rebriefed").await;

  generate(
    &ground,
    &ECHO,
    &Scripted::new(vec![answered(json!([item("a cat", "cat")]), "t1")]),
    Some(1),
  )
  .await;

  let rewritten = Scripted::new(vec![answered(json!([item("a dog", "dog")]), "t2")]);
  let told_more = Echo {
    brief: "THE GATE: echo, told more",
    ..ECHO
  };

  generate(&ground, &told_more, &rewritten, Some(2)).await;

  assert_eq!(rewritten.threads(), [None]);
  assert!(rewritten.prompt(0).contains("THE GATE: echo, told more"));
}

fn line(difficulty: &str, pass: bool, met: usize, ms: u64) -> ScoreLine {
  ScoreLine {
    score: Score {
      answered: true,
      pass,
      met,
      checks: 2,
      misses: vec![],
      answer: None,
    },
    gate: "g".to_owned(),
    id: "g-0001".to_owned(),
    difficulty: difficulty.to_owned(),
    road: "claude".to_owned(),
    model: "m".to_owned(),
    ms,
  }
}

#[test]
fn a_gate_s_figures_count_its_passes_its_share_and_its_times() {
  let figures =
    figures_of("g", "claude", "m", &[line("easy", true, 2, 1_000), line("borderline", false, 1, 3_000)]);

  assert_eq!((figures.asked, figures.answered, figures.passed), (2, 2, 1));
  assert_eq!(figures.share, 0.75);
  assert_eq!((figures.easy.passed, figures.borderline.asked), (1, 1));
  assert_eq!((figures.median_seconds, figures.ninetieth_seconds), (3.0, 3.0));
}

#[test]
fn a_sample_is_spread_evenly_over_the_set() {
  assert_eq!(spread(&[0, 1, 2, 3, 4, 5], Some(3)), [0, 2, 4]);
  assert_eq!(spread(&[0, 1], Some(5)), [0, 1]);
  assert_eq!(spread(&[0, 1], None), [0, 1]);
}

#[test]
fn a_road_is_claude_or_a_named_registration() {
  let args = |road: &str, registration: Option<&str>| GateEvalArgs {
    road: vec![road.to_owned()],
    registration: registration.iter().map(|one| (*one).to_owned()).collect(),
    ..GateEvalArgs::default()
  };

  assert_eq!(road_of(&args("claude", None)).unwrap(), Road::Claude);
  assert_eq!(
    road_of(&args("registered", Some("a-model"))).unwrap(),
    Road::Registered("a-model".to_owned())
  );
  assert!(road_of(&args("registered", None)).is_err());
  assert!(road_of(&args("elsewhere", None)).is_err());
}

#[test]
fn the_generation_s_unit_runs_the_same_words_in_the_foreground() {
  let args = GateEvalArgs {
    set: vec!["v2".to_owned()],
    gates: vec!["translator".to_owned()],
    batch: vec!["4".to_owned()],
    ..GateEvalArgs::default()
  };

  assert_eq!(
    unit_words(&args),
    ["gate", "eval", "generate", "--set", "v2", "--gate", "translator", "--batch", "4"]
  );
}

#[tokio::test]
async fn a_scoring_run_asks_each_item_on_its_road_and_reports_the_last_score_of_each_road() {
  let ground = ground("score").await;
  // The scoring goes through the gate's own run, so the member stands for a gate the order holds.
  let seeker = Echo {
    stage: "document-seek",
    ..ECHO
  };
  let folder = set_folder(&ground.data_root, "v1").join(seeker.stage);
  let stored = [("s-0001", "a cat", "cat", "easy"), ("s-0002", "a dog", "dog", "borderline")];

  std::fs::create_dir_all(&folder).unwrap();
  std::fs::write(
    folder.join("items.jsonl"),
    stored
      .iter()
      .map(|(id, text, word, difficulty)| {
        json!({ "id": id, "gate": "document-seek", "topic": "t", "difficulty": difficulty, "why": "w", "input": { "text": text }, "key": { "word": word } })
          .to_string()
      })
      .collect::<Vec<_>>()
      .join("\n"),
  )
  .unwrap();
  ground.gateway.answers(vec![completion("a cat it is"), completion("no animal")]);

  let given = Scoring {
    stages: ground.stages.clone(),
    data_root: &ground.data_root,
    set: "v1",
    road: Road::Registered("a-model".to_owned()),
    limit: None,
    log: &|_| {},
  };
  let run = score_set(&[&seeker], &given).await.unwrap();
  let asked = ground.gateway.asked.lock().unwrap().clone();

  assert_eq!(run.road, "registered");
  assert_eq!(
    (run.gates[0].asked, run.gates[0].passed, run.gates[0].model.as_str()),
    (2, 1, "a-model")
  );
  assert!(asked.iter().all(|one| one.model == "a-model"));
  assert_eq!(latest_figures(&ground.data_root, "v1").len(), 1);

  let lines = report(&ground.data_root, "v1");

  assert!(
    lines[1].starts_with("document-seek | registered | a-model | 2 | 2 | 1 | 50% | 1/1 | 0/1 | "),
    "{lines:?}"
  );
  assert_eq!(report(&ground.data_root, "v2"), ["Set v2 has no scores yet."]);
}
