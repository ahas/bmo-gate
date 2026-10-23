//! A gate's run on each road: one gateway request for a registered model, one thrown-away session's turn for a
//! provider's program, a stop raised, a wait run out, a request cut where it was too large, and the roads that
//! run nothing; each with the road it leaves.

use std::sync::Arc;
use std::time::Duration;

use gate_ports::PortError;
use gate_runs::{GateError, GateRequest, Piece, Split};
use serde_json::json;

use crate::fakes::{completion, mapping, provider, turn_end};
use crate::{ground, runs_of, wait};

/// The roads written, oldest first: each its provider, model, outcome, tokens in, out and read, and round.
async fn roads(scratch: &crate::scratch::Scratch) -> Vec<String> {
  scratch
    .texts(
      "SELECT concat_ws(' ', stage, provider, model, outcome, coalesce(input_tokens::text, '-'), \
       coalesce(output_tokens::text, '-'), coalesce(cache_read_tokens::text, '-'), coalesce(round, '-'), \
       coalesce(chat_id::text, '-'), coalesce(message_id::text, '-')) FROM gate_roads ORDER BY id",
      vec![],
    )
    .await
}

#[tokio::test]
async fn a_registered_model_is_one_gateway_request_with_the_gates_room_thinking_and_sampling() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("registry", true));
  agency.route("room-rules", "registry");
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("registry".into(), mapping("registry", "a-registration", Some("thinking"), Some(3000)));
  gateway.answers(vec![completion(" PICK a \n")]);
  wait(&runs, "room-rules", 30_000).await;

  let mut request = GateRequest::new("the instructions", "the material");

  request.chat_id = Some(7);
  request.message_id = Some(9);
  request.round = Some("round-1".into());

  let answer = runs.run("room-rules", &request).await.unwrap();
  let asked = gateway.asked.lock().unwrap()[0].clone();

  assert_eq!(answer.as_deref(), Some("PICK a"));
  assert_eq!(asked.model, "a-registration");
  assert_eq!(asked.system, "the instructions");
  assert_eq!(asked.input, "the material");
  assert_eq!(asked.max_tokens, 3000);
  assert!(asked.thinking);
  assert!(asked.wait <= Duration::from_secs(30) && asked.wait > Duration::from_secs(25));
  assert_eq!(
    serde_json::from_str::<serde_json::Value>(&asked.sampling.unwrap()).unwrap()["temperature"],
    0.1
  );
  assert_eq!(
    agency.resolved.lock().unwrap()[0],
    ("room-rules".into(), Some("registry".into()), "Simple".into())
  );
  assert_eq!(
    roads(&scratch).await,
    ["room-rules registry a-registration answered 20 7 100 round-1 7 9"]
  );
}

#[tokio::test]
async fn a_programs_provider_is_one_thrown_away_session_and_its_one_turn() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("claude-code", false));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("claude-code".into(), mapping("claude-code", "a-model", Some("low"), None));
  *agency.end.lock().unwrap() = Some(turn_end(
    "answered",
    Some("FOLD"),
    Some(
      json!({ "model": "a-model", "spend": [{ "inputTokens": 5, "outputTokens": 2, "cacheReadTokens": 1 }] }),
    ),
  ));
  wait(&runs, "output-format", 30_000).await;

  let mut request = GateRequest::new("fold or not", "the reply");

  request.thinking = false;
  request.chat_id = Some(-5);

  let answer = runs.run("output-format", &request).await.unwrap();
  let started = agency.started.lock().unwrap().clone();
  let turn = agency.turns.lock().unwrap()[0].clone();

  assert_eq!(answer.as_deref(), Some("FOLD"));
  assert_eq!(started.len(), 1);
  assert_eq!(started[0].0, "output-format");
  assert_eq!(started[0].1.provider, "claude-code");
  assert_eq!(started[0].1.model, "a-model");
  assert_eq!(started[0].1.cwd, "/a/session/folder");
  assert_eq!(turn.session, "session-1");
  assert_eq!(turn.system, "fold or not");
  assert_eq!(turn.prompt, "the reply");
  assert!(!turn.thinking);
  assert_eq!(turn.work_key, "output-format");
  assert_eq!(turn.mapping.effort.as_deref(), Some("low"));
  assert_eq!(turn.mapping.tier.as_deref(), Some("Simple"));
  assert_eq!(turn.chat, Some(-5));
  assert!(turn.name.starts_with("gate:output-format:"));
  assert_eq!(roads(&scratch).await, ["output-format claude-code a-model answered 5 2 1 - -5 -"]);
}

#[tokio::test]
async fn a_turn_somebody_stopped_is_raised_and_its_road_says_so() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("codex", false));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("codex".into(), mapping("codex", "a-codex-model", None, None));
  *agency.end.lock().unwrap() = Some(turn_end("stopped", None, None));
  wait(&runs, "translator", 30_000).await;

  let stopped = runs.run("translator", &GateRequest::new("translate", "words")).await;

  assert!(matches!(stopped, Err(GateError::Stopped(_))), "{stopped:?}");
  assert_eq!(roads(&scratch).await, ["translator codex a-codex-model stopped - - - - - -"]);
}

#[tokio::test]
async fn a_turn_past_its_wait_is_stopped_and_the_gate_has_no_answer() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("claude-code", false));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("claude-code".into(), mapping("claude-code", "a-model", None, None));
  *agency.end.lock().unwrap() = Some(turn_end("answered", Some("late"), None));
  *agency.turn_takes.lock().unwrap() = Duration::from_secs(5);
  wait(&runs, "sanitizer", 1_000).await;

  let answer = runs.run("sanitizer", &GateRequest::new("clean", "text")).await.unwrap();
  let stopped = agency.stopped.lock().unwrap().clone();

  assert_eq!(answer, None);
  assert_eq!(stopped.len(), 1);
  assert!(stopped[0].starts_with("session-"));
  assert_eq!(roads(&scratch).await, ["sanitizer claude-code a-model timeout - - - - - -"]);
}

#[tokio::test]
async fn a_gate_whose_row_holds_no_wait_is_not_run() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("claude-code", false));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("claude-code".into(), mapping("claude-code", "a-model", None, None));

  assert_eq!(runs.run("room-rules", &GateRequest::new("s", "p")).await.unwrap(), None);
  assert!(agency.turns.lock().unwrap().is_empty());
  assert!(roads(&scratch).await.is_empty());
}

#[tokio::test]
async fn a_gate_on_laya_runs_no_model_and_asks_its_fallback_where_its_caller_says_laya_gave_none() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("registry", true));
  agency.route("system-documents", "laya");
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("registry".into(), mapping("registry", "a-registration", None, None));
  gateway.answers(vec![completion("YES")]);
  wait(&runs, "system-documents", 30_000).await;

  assert_eq!(runs.run("system-documents", &GateRequest::new("s", "p")).await.unwrap(), None);
  assert!(gateway.asked.lock().unwrap().is_empty());

  let mut fallback = GateRequest::new("s", "p");

  fallback.laya_fallback = true;

  assert_eq!(runs.run("system-documents", &fallback).await.unwrap().as_deref(), Some("YES"));
  assert_eq!(
    roads(&scratch).await,
    ["system-documents registry a-registration answered 20 7 100 - - -"]
  );
}

#[tokio::test]
async fn a_registration_named_by_the_caller_is_run_on_alone() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("claude-code", false));
  agency.providers.lock().unwrap().push(provider("registry", true));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("registry".into(), mapping("registry", "the-tier-model", None, Some(9000)));
  gateway.answers(vec![completion("a reading")]);
  wait(&runs, "translator", 30_000).await;

  let mut request = GateRequest::new("translate the part", "the part");

  request.registration = Some("an-agents-model".into());

  assert_eq!(runs.run("translator", &request).await.unwrap().as_deref(), Some("a reading"));

  let asked = gateway.asked.lock().unwrap()[0].clone();

  assert_eq!(asked.model, "an-agents-model");
  assert_eq!(asked.max_tokens, 9000);
  assert!(agency.turns.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_provider_that_maps_the_gate_to_nothing_leaves_it_unavailable() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("codex", false));
  agency.route("document-seek", "codex");
  wait(&runs, "document-seek", 30_000).await;

  assert_eq!(runs.run("document-seek", &GateRequest::new("s", "p")).await.unwrap(), None);
  assert!(agency.started.lock().unwrap().is_empty());
  assert_eq!(roads(&scratch).await, ["document-seek codex  unavailable - - - - - -"]);
}

// A caller's cut: the first part answered by the caller itself, the other two asked, the answers joined.
struct Halves;

impl Split for Halves {
  fn halve(&self) -> Option<Vec<Piece>> {
    Some(vec![
      Piece::Answered("kept".into()),
      Piece::Asked(GateRequest::new("translate", "first half")),
      Piece::Asked(GateRequest::new("translate", "second half")),
    ])
  }

  fn join(&self, answers: Vec<Option<String>>) -> Option<String> {
    answers.into_iter().collect::<Option<Vec<_>>>().map(|parts| parts.join("|"))
  }
}

#[tokio::test]
async fn a_request_past_the_registrations_window_is_cut_by_its_caller_and_each_part_asked() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("registry", true));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("registry".into(), mapping("registry", "a-registration", None, None));
  gateway.answers(vec![
    Err(PortError::Refused {
      unit: "the model gateway",
      call: "chat completion",
      status: 400,
      code: String::new(),
      error: "This model's maximum context length is 32768 tokens".into(),
    }),
    completion("one"),
    completion("two"),
  ]);
  wait(&runs, "translator", 30_000).await;

  let mut request = GateRequest::new("translate", "the whole");

  request.split = Some(Arc::new(Halves));

  assert_eq!(runs.run("translator", &request).await.unwrap().as_deref(), Some("kept|one|two"));
  assert_eq!(
    roads(&scratch).await,
    [
      "translator registry a-registration too-large - - - - - -",
      "translator registry a-registration answered 20 7 100 - - -",
      "translator registry a-registration answered 20 7 100 - - -",
    ]
  );
}

#[test]
fn a_complaint_about_the_window_is_a_request_too_large() {
  use gate_runs::gateway::says_too_large;

  assert!(says_too_large("This model's maximum context length is 32768 tokens"));
  assert!(says_too_large("maximum number of tokens exceeded"));
  assert!(!says_too_large("tokens over the maximum"));
  assert!(!says_too_large("bad request"));
}

#[test]
fn an_answer_as_a_verdict_line_is_its_first_line_cut_in_utf16_units() {
  use gate_runs::records::verdict_line;

  assert_eq!(verdict_line("  SKIP \nwhy", 10), "SKIP");
  assert_eq!(verdict_line("abcdef", 3), "abc\u{2026}");
  assert_eq!(verdict_line("a\u{1f600}b", 2), "a\u{2026}");
}
