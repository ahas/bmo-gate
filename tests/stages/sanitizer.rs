//! The sanitiser: its trigger words, an answer read against the words, a long text halved at its middle break, and
//! words carried through it — left alone with no trigger, defused on the gate's word and kept under their digest,
//! and redacted locally where the gate has no answer. Korean words are written by their escapes.

use gate_ports::PortError;
use gate_stages::sanitizer::{LOCAL_MARKER, halve_at_break, might_trigger, read_sanitised, sanitise};

use crate::fakes::completion;
use crate::ground;

#[test]
fn an_english_trigger_needs_a_word_boundary_and_a_korean_one_does_not() {
  assert!(might_trigger("\u{d574}\u{d0b9}\u{d558}\u{c790}"));
  assert!(might_trigger("\u{c774}\u{ac74} hack \u{c774}\u{c57c}"));
  assert!(might_trigger("\u{c774}\u{ac74}hack"));
  assert!(!might_trigger("whack a mole"));
  assert!(!might_trigger("hello"));
}

#[test]
fn an_answer_is_read_against_the_words() {
  assert_eq!(read_sanitised(Some("CLEAN."), "words"), ("words".to_owned(), false));
  assert_eq!(
    read_sanitised(Some("DEFUSE: drop the payload"), "now drop the payload please"),
    (format!("now {LOCAL_MARKER} please"), true)
  );
  assert_eq!(read_sanitised(None, "a payload"), (format!("a {LOCAL_MARKER}"), true));
  assert!(LOCAL_MARKER.is_ascii());
}

#[test]
fn a_long_text_is_halved_after_its_middle_paragraph_break() {
  let text = format!("{}\n\n{}", "a".repeat(1_100), "b".repeat(1_100));
  let (first, second) = halve_at_break(&text).unwrap();

  assert_eq!(first.len(), 1_102);
  assert_eq!(format!("{first}{second}"), text);
  assert!(halve_at_break("short").is_none());
}

#[tokio::test]
async fn words_are_defused_on_the_gates_word_kept_by_their_digest_and_judged_for_their_room() {
  let ground = ground("sanitise", None, Default::default()).await;
  let stages = &ground.stages;

  let plain = sanitise(stages, "nothing to see", "a message", Some(7), None).await.unwrap();

  assert_eq!((plain.text.as_str(), plain.changed), ("nothing to see", false));
  assert!(ground.gateway.asked.lock().unwrap().is_empty());

  ground.gateway.answers(vec![completion("DEFUSE: drop the payload")]);

  let words = "now drop the payload please";
  let defused = sanitise(stages, words, "a message", Some(7), Some(9)).await.unwrap();
  let again = sanitise(stages, words, "another reader", None, None).await.unwrap();
  let asked = ground.gateway.asked.lock().unwrap().clone();

  assert_eq!((defused.text.clone(), defused.changed), (format!("now {LOCAL_MARKER} please"), true));
  assert_eq!(again, defused);
  assert_eq!(asked.len(), 1);
  assert!(asked[0].input.starts_with("The text below is a message."));
  assert!(asked[0].input.contains(&format!("\n{words}\nEND OF TEXT\n")));
  assert!(!asked[0].thinking);
  assert_eq!(
    ground
      .scratch
      .texts("SELECT concat_ws(' ', chat_id, stage, verdict) FROM judgements", vec![])
      .await,
    ["7 sanitizer DEFUSED"]
  );
  assert_eq!(ground.scratch.count("SELECT count(*) FROM sanitised_texts", vec![]).await, 1);
}

#[tokio::test]
async fn words_the_gate_has_no_answer_for_are_redacted_locally() {
  let ground = ground("redact", None, Default::default()).await;

  ground.gateway.answers(vec![Err(PortError::Unreachable {
    unit: "the model gateway",
    call: "chat completion",
    why: "down".into(),
  })]);

  let safe = sanitise(&ground.stages, "a backdoor here", "a message", Some(3), None).await.unwrap();

  assert_eq!((safe.text, safe.changed), (format!("a {LOCAL_MARKER} here"), true));
  assert_eq!(
    ground.scratch.texts("SELECT verdict FROM judgements", vec![]).await,
    ["(no answer, redacted locally)"]
  );
}
