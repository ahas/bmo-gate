//! Laya's client and its modes: numbers written as the training tooling writes them, the relay's failures named
//! by its status, a busy card by the engine's reason, a request carried in calls of the relay's size, and a gate's
//! verdict by way of Laya in shadow, in filter and on Laya's own road, with the pair each keeps.

use axum::http::Method;
use gate_runs::GateError;
use gate_stages::laya::{
  self, Failure, LayaRun, Probe, Question, Reading, Reply, Request, busy_reason, failure_of, judge_on_laya,
  judge_with_laya, number,
};
use gate_stages::laya_health::{pass, read};
use gate_stages::ordered::Ordered;
use serde_json::json;

use crate::stub::Stub;
use crate::{ground, scratch::Scratch};

#[test]
fn a_number_is_written_as_the_training_tooling_writes_it() {
  assert_eq!(serde_json::to_string(&number(1.0)).unwrap(), "1");
  assert_eq!(serde_json::to_string(&number(0.25)).unwrap(), "0.25");
}

#[test]
fn a_failure_is_named_by_the_servers_status() {
  assert_eq!(failure_of(400, "head_max_len exceeded"), "too-large");
  assert_eq!(failure_of(504, ""), "timeout");
  assert_eq!(failure_of(503, ""), "unreachable");
  assert_eq!(failure_of(500, ""), "bad-answer");
  assert_eq!(failure_of(401, ""), "refused");
}

#[test]
fn a_busy_card_is_read_from_the_engines_own_reason() {
  let said = |reason: &str| json!({ "error": reason }).to_string();
  let taken = said("the card is taken for a-trainer");

  assert_eq!(failure_of(503, &taken), "busy");
  assert_eq!(busy_reason(&taken).as_deref(), Some("the card is taken for a-trainer"));
  assert_eq!(failure_of(503, &said("the card has no room for the room-rules checkpoint")), "busy");
  assert_eq!(failure_of(503, &said("laya has no place among this node's occupants")), "busy");

  // The front's word for an engine that does not answer, and the relay's for no node taking the call, are no
  // busy card, even where a node it passed was one.
  assert_eq!(failure_of(503, &said("laya is not answering")), "unreachable");
  assert_eq!(
    failure_of(503, &said("No Laya node took the call: a: 503 the card is taken for x; b: not reached")),
    "unreachable"
  );
  assert_eq!(failure_of(503, "the card is taken for a-trainer"), "unreachable");
}

#[test]
fn many_questions_go_in_calls_of_at_most_the_servers_count() {
  let request = Request {
    state: Ordered::text("x"),
    questions: (0..130)
      .map(|at| {
        (
          format!("q{at}"),
          Question::Noul {
            instructions: "?".into(),
          },
        )
      })
      .collect(),
  };

  assert_eq!(
    request.parts().iter().map(|part| part.questions.len()).collect::<Vec<_>>(),
    vec![128, 2]
  );
}

// A probe of one yes/no over its input, whose yes is SAFE: the verdict Laya may settle alone.
#[derive(Clone, Copy)]
struct YesNo;

impl Probe for YesNo {
  type Input = String;
  type Verdict = String;

  fn question(&self, input: &String) -> Result<Request, Failure> {
    Ok(Request {
      state: Ordered::text(input.as_str()),
      questions: vec![(
        "ok".to_owned(),
        Question::Noul {
          instructions: "is it fine?".into(),
        },
      )],
    })
  }

  fn read(&self, reply: &Reply) -> Result<Reading, Failure> {
    laya::noul_reading(reply, "ok", "SAFE", "UNSAFE")
  }

  fn verdict_of(&self, label: &str) -> Option<String> {
    Some(label.to_owned())
  }

  fn label_of(&self, verdict: &String) -> String {
    verdict.clone()
  }

  fn truth_of(&self, label: &str, _request: &Request) -> Option<Ordered> {
    Some(Ordered::map([("ok", Ordered::Flag(label == "SAFE"))]))
  }

  fn safe_label(&self) -> Option<&str> {
    Some("SAFE")
  }
}

fn relay_answers(stub: &Stub, noul: f64) {
  stub.answer(
    Method::POST,
    "/decide",
    200,
    json!({ "answers": { "ok": { "type": "noul", "noul": noul, "confidence": 0.97 } } }),
  );
}

async fn pairs(scratch: &Scratch) -> Vec<String> {
  scratch
    .texts(
      "SELECT concat_ws(' ', stage, mode, used, coalesce(laya_verdict, '-'), coalesce(llm_verdict, '-'), \
       coalesce(failure, '-')) FROM laya_verdicts ORDER BY id",
      vec![],
    )
    .await
}

#[tokio::test]
async fn in_shadow_the_llm_decides_and_the_pair_is_kept_once_both_settled() {
  let stub = Stub::start().await;
  let ground = ground("shadow", Some(&stub), Default::default()).await;

  relay_answers(&stub, 0.9);

  let verdict = judge_with_laya(
    &ground.stages,
    &LayaRun::of("room-rules", Some(7), None),
    &YesNo,
    &"x".into(),
    |_| async { Ok::<_, GateError>(Some("UNSAFE".to_owned())) },
  )
  .await
  .unwrap();

  laya::settled().await;

  let asked = stub.one("/decide");

  assert_eq!(verdict.as_deref(), Some("UNSAFE"));
  assert_eq!(asked.bearer().as_deref(), Some("relay-token"));
  assert_eq!(
    asked.body,
    r#"{"gate":"room-rules","state":"x","questions":{"ok":{"type":"noul","instructions":"is it fine?"}}}"#
  );
  assert_eq!(pairs(&ground.scratch).await, ["room-rules shadow llm SAFE UNSAFE -"]);
}

#[tokio::test]
async fn in_filter_a_verdict_sure_past_tau_stands_and_the_llm_is_not_asked() {
  let stub = Stub::start().await;
  let ground = ground("filter", Some(&stub), Default::default()).await;

  ground
    .scratch
    .run(
      "UPDATE gate_options SET laya_mode = 'filter', laya_tau = 0.8 WHERE key = 'room-rules'",
      vec![],
    )
    .await
    .unwrap();
  relay_answers(&stub, 0.96);

  let verdict = judge_with_laya(
    &ground.stages,
    &LayaRun::of("room-rules", None, None),
    &YesNo,
    &"x".into(),
    |_| async {
      Err::<Option<String>, _>(GateError::Fault("the LLM is not asked where Laya's verdict stands".into()))
    },
  )
  .await
  .unwrap();

  assert_eq!(verdict.as_deref(), Some("SAFE"));
  assert_eq!(pairs(&ground.scratch).await, ["room-rules filter laya SAFE - -"]);
}

#[tokio::test]
async fn off_or_with_no_relay_named_the_llm_alone_decides() {
  let ground = ground("no-relay", None, Default::default()).await;
  let verdict = judge_with_laya(
    &ground.stages,
    &LayaRun::of("room-rules", None, None),
    &YesNo,
    &"x".into(),
    |_| async { Ok::<_, GateError>(Some("UNSAFE".to_owned())) },
  )
  .await
  .unwrap();

  assert_eq!(verdict.as_deref(), Some("UNSAFE"));
  assert!(pairs(&ground.scratch).await.is_empty());
}

#[tokio::test]
async fn on_lays_road_its_label_is_the_verdict_and_its_failure_falls_to_the_fallback() {
  let stub = Stub::start().await;
  let ground = ground("road", Some(&stub), Default::default()).await;
  let run = LayaRun::of("room-rules", None, None);

  relay_answers(&stub, 0.2);

  let decided = judge_on_laya(&ground.stages, &run, &YesNo, &"x".into(), "DEFAULT".to_owned(), |_| async {
    Err::<Option<String>, _>(GateError::Fault("the fallback is not asked where Laya gave a verdict".into()))
  })
  .await
  .unwrap();

  assert_eq!((decided.verdict.as_str(), decided.decided_by), ("UNSAFE", laya::DecidedBy::Laya));

  stub.answer(Method::POST, "/decide", 503, json!({}));

  let fallen = judge_on_laya(&ground.stages, &run, &YesNo, &"x".into(), "DEFAULT".to_owned(), |_| async {
    Ok::<_, GateError>(Some("SAFE".to_owned()))
  })
  .await
  .unwrap();

  assert_eq!(
    (fallen.verdict.as_str(), fallen.decided_by, fallen.failure),
    ("SAFE", laya::DecidedBy::Llm, Some("unreachable"))
  );
  assert_eq!(
    pairs(&ground.scratch).await,
    ["room-rules road laya UNSAFE - -", "room-rules road llm - SAFE unreachable"]
  );
}

#[tokio::test]
async fn a_call_that_waited_behind_one_turned_away_is_not_sent() {
  let stub = Stub::start().await;
  let ground = ground("turned-away", Some(&stub), Default::default()).await;
  let request = YesNo.question(&"x".to_owned()).unwrap();
  let wait = std::time::Duration::from_secs(5);

  stub.answer(Method::POST, "/decide", 503, json!({}));

  let (first, second) = tokio::join!(
    laya::ask(&ground.stages.laya, "room-rules", &request, wait),
    laya::ask(&ground.stages.laya, "library-knowledge", &request, wait)
  );

  assert_eq!(
    (first.err().map(|missed| missed.failure), second.err().map(|missed| missed.failure)),
    (Some("unreachable"), Some("unreachable"))
  );
  assert_eq!(stub.seen().iter().filter(|seen| seen.path == "/decide").count(), 1);

  // A call that joins the line after the door turned one away is sent.
  relay_answers(&stub, 0.9);

  assert!(laya::ask(&ground.stages.laya, "room-rules", &request, wait).await.is_ok());
  assert_eq!(stub.seen().iter().filter(|seen| seen.path == "/decide").count(), 2);
}

#[tokio::test]
async fn a_busy_card_falls_to_the_fallback_at_once_with_the_engines_reason() {
  let stub = Stub::start().await;
  let ground = ground("busy-card", Some(&stub), Default::default()).await;
  let run = LayaRun::of("room-rules", None, None);

  stub.answer(Method::POST, "/decide", 503, json!({ "error": "the card is taken for a-trainer" }));

  let fallen = judge_on_laya(&ground.stages, &run, &YesNo, &"x".into(), "DEFAULT".to_owned(), |_| async {
    Ok::<_, GateError>(Some("SAFE".to_owned()))
  })
  .await
  .unwrap();

  assert_eq!(
    (fallen.verdict.as_str(), fallen.decided_by, fallen.failure),
    ("SAFE", laya::DecidedBy::Llm, Some("busy"))
  );
  assert_eq!(fallen.failure_said(), "busy: the card is taken for a-trainer");
  assert_eq!(pairs(&ground.scratch).await, ["room-rules road llm - SAFE busy"]);
}

#[tokio::test]
async fn a_call_that_waited_behind_a_busy_card_leaves_busy_unsent() {
  let stub = Stub::start().await;
  let ground = ground("busy-line", Some(&stub), Default::default()).await;
  let request = YesNo.question(&"x".to_owned()).unwrap();
  let wait = std::time::Duration::from_secs(5);

  stub.answer(Method::POST, "/decide", 503, json!({ "error": "the card is taken for a-trainer" }));

  let (first, second) = tokio::join!(
    laya::ask(&ground.stages.laya, "room-rules", &request, wait),
    laya::ask(&ground.stages.laya, "library-knowledge", &request, wait)
  );
  let busy = laya::Missed {
    failure: "busy",
    reason: Some("the card is taken for a-trainer".to_owned()),
  };

  assert_eq!((first.err(), second.err()), (Some(busy.clone()), Some(busy)));
  assert_eq!(stub.seen().iter().filter(|seen| seen.path == "/decide").count(), 1);
}

#[tokio::test]
async fn the_health_row_reads_busy_while_the_last_call_found_the_card_taken() {
  let stub = Stub::start().await;
  let ground = ground("busy-health", Some(&stub), Default::default()).await;
  let side = &ground.stages.laya;
  let db = ground.scratch.db();
  let request = YesNo.question(&"x".to_owned()).unwrap();
  let wait = std::time::Duration::from_secs(5);

  stub.answer(
    Method::GET,
    "/health",
    200,
    json!({ "state": "up", "model": "room-rules=/w/a", "device": "cuda:0" }),
  );
  stub.answer(Method::POST, "/decide", 503, json!({ "error": "the card is taken for a-trainer" }));

  assert!(laya::ask(side, "room-rules", &request, wait).await.is_err());
  assert!(pass(db, side, 100).await.unwrap());
  assert_eq!(read(db).await.unwrap().state, "busy");

  // The first call answered after it lets the next check read the server up again.
  relay_answers(&stub, 0.9);

  assert!(laya::ask(side, "room-rules", &request, wait).await.is_ok());
  assert!(pass(db, side, 160).await.unwrap());
  assert_eq!(read(db).await.unwrap().state, "up");
}
