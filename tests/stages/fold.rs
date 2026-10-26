//! The state the fold asks Laya about: a short message whole in its opening with its counts, a long one by its
//! opening and closing within the state's budget, and the probe's one question in the wording the checkpoint it
//! asks learnt.

use gate_policy::laya::{LEARNT, QUESTIONS};
use gate_stages::fold::{FOLD_QUESTION, FoldProbe, STATE_TOKENS, fold_state};
use gate_stages::laya::{Probe, Question, estimated_tokens};

#[test]
fn a_short_message_stands_whole_in_the_opening_with_its_counts() {
  let state = fold_state("  A short answer.\n\n- one\n- two\n");

  assert_eq!(
    serde_json::to_string(&state).unwrap(),
    r#"{"head":"A short answer.\n\n- one\n- two","tail":"","chars":28,"lines":3,"paragraphs":2,"items":2,"headings":0,"code":0,"table":0}"#
  );
}

#[test]
fn a_long_message_is_asked_by_its_opening_and_closing() {
  let text = (0..200).map(|at| format!("line {at} of a long answer")).collect::<Vec<_>>().join("\n");
  let state = fold_state(&text);
  let read: serde_json::Value = serde_json::to_value(&state).unwrap();

  assert!(read["head"].as_str().unwrap().starts_with("line 0 "));
  assert!(read["tail"].as_str().unwrap().ends_with("line 199 of a long answer"));
  assert!(estimated_tokens(&serde_json::to_string(&state).unwrap()) <= STATE_TOKENS);
}

#[test]
fn the_fold_asks_laya_its_one_trained_question() {
  let request = FoldProbe::default().question(&"a reply".to_owned()).unwrap();

  assert_eq!(request.questions.len(), 1);
  assert!(
    matches!(&request.questions[0].1, Question::Noul { instructions } if *instructions == QUESTIONS.fold)
  );
  assert_eq!(FoldProbe::default().verdict_of("FOLD").as_deref(), Some("FOLD"));
  assert_eq!(FoldProbe::default().verdict_of("maybe"), None);
}

// The question a probe asks, as its request carries it.
fn asked(probe: &FoldProbe) -> String {
  match &probe.question(&"a reply".to_owned()).unwrap().questions[0] {
    (id, Question::Noul { instructions }) if id == FOLD_QUESTION => instructions.clone(),
    other => panic!("not the fold's question: {other:?}"),
  }
}

#[test]
fn the_fold_asks_the_checkpoint_it_reaches_the_wording_that_checkpoint_learnt() {
  let learnt = &LEARNT["checkpoints/output-format/real-2-fold"][FOLD_QUESTION];

  assert_ne!(learnt, &QUESTIONS.fold);
  assert_eq!(
    asked(&FoldProbe::for_checkpoint(Some("checkpoints/output-format/real-2-fold/step-000048"))),
    *learnt
  );
  assert_eq!(
    asked(&FoldProbe::for_checkpoint(Some("checkpoints/output-format/real-2-fold"))),
    *learnt
  );

  // A checkpoint the table does not list, a run whose name only opens the same way, and no checkpoint named at all
  // are asked the gate's own wording.
  for folder in [
    Some("checkpoints/output-format/real-3-fold/step-000010"),
    Some("checkpoints/output-format/real-2-folded/step-000048"),
    None,
  ] {
    assert_eq!(asked(&FoldProbe::for_checkpoint(folder)), QUESTIONS.fold, "{folder:?}");
  }

  assert_eq!(asked(&FoldProbe::default()), QUESTIONS.fold);
}
