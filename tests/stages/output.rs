//! The output gate: a fold read off its word, a short part sent with nothing asked, a long one folded on the gate's
//! FOLD with its judgement written, open where the gate has no answer, and plain where no candidate stands.

use gate_stages::output::{
  FOLD, GATE_KEY, OPEN, RULEBOOKS, decided, format_request, instructions, parse_fold,
};

use crate::fakes::completion;
use crate::ground;

#[test]
fn a_fold_is_read_off_its_word_whatever_surrounds_it() {
  assert_eq!(parse_fold("FOLD"), Some(FOLD));
  assert_eq!(parse_fold("  **open** because it is short"), Some(OPEN));
  assert_eq!(parse_fold("```\nFOLD\n```"), Some(FOLD));
  assert_eq!(parse_fold("FOLDED"), None);
  assert_eq!(parse_fold("maybe"), None);
}

#[test]
fn the_gate_is_asked_the_message_as_data_between_markers() {
  let asked = format_request("<b>hi</b>");

  assert!(asked.contains("\n<b>hi</b>\nEND OF MESSAGE\n"));
  assert!(asked.ends_with("FOLD or OPEN."));
}

// A part long enough to fold, with marks of its own: many lines of a list.
fn long_part() -> String {
  (0..30)
    .map(|at| format!("- step **{at}** of the plan, said in full"))
    .collect::<Vec<_>>()
    .join("\n")
}

#[tokio::test]
async fn a_long_part_is_folded_on_the_gates_word_and_its_judgement_written() {
  let ground = ground("fold", None, Default::default()).await;

  ground
    .scratch
    .run("UPDATE gate_options SET laya_mode = 'off' WHERE key = $1", vec![GATE_KEY.into()])
    .await
    .unwrap();
  ground.gateway.answers(vec![completion("FOLD")]);

  let system = instructions(&ground.stages).await.unwrap();
  let markup = decided(&ground.stages, 7, &long_part()).await.unwrap();
  let asked = ground.gateway.asked.lock().unwrap()[0].clone();

  assert!(markup.starts_with("<blockquote expandable>"), "{markup}");
  assert!(RULEBOOKS.iter().all(|name| system.contains(&format!("the {name} rulebook"))));
  assert_eq!(asked.system, system);
  assert_eq!(
    ground
      .scratch
      .texts("SELECT concat_ws(' ', chat_id, stage, verdict) FROM judgements", vec![])
      .await,
    [format!("7 {GATE_KEY} FOLD")]
  );
}

#[tokio::test]
async fn a_short_part_asks_nothing_and_a_part_with_no_answer_goes_out_open() {
  let ground = ground("open", None, Default::default()).await;

  assert_eq!(
    decided(&ground.stages, 7, "Short and **bold**.").await.as_deref(),
    Some("Short and <b>bold</b>.")
  );
  assert!(ground.gateway.asked.lock().unwrap().is_empty());
  assert_eq!(decided(&ground.stages, 7, "Short and plain.").await, None);

  let open = decided(&ground.stages, 7, &long_part()).await.unwrap();

  assert!(!open.contains("blockquote"), "{open}");
  assert_eq!(
    ground
      .scratch
      .count("SELECT count(*) FROM judgements WHERE verdict = 'OPEN'", vec![])
      .await,
    1
  );
}

// The fold's question as the Laya stub was asked it.
fn fold_asked(stub: &crate::stub::Stub) -> String {
  stub.one("/decide").json()["questions"][gate_stages::fold::FOLD_QUESTION]["instructions"]
    .as_str()
    .unwrap_or_default()
    .to_owned()
}

#[tokio::test]
async fn the_gate_asks_laya_in_the_wording_its_served_checkpoint_learnt() {
  let learnt = &gate_policy::laya::LEARNT["checkpoints/output-format/real-2-fold"]["fold"];
  let answer =
    serde_json::json!({ "answers": { "fold": { "type": "noul", "noul": 0.9, "confidence": 0.97 } } });

  // The checkpoint the last check names learnt the earlier wording, and is asked it beside the gate's model.
  let stub = crate::stub::Stub::start().await;
  let ground = ground("fold-learnt", Some(&stub), Default::default()).await;

  stub.answer(axum::http::Method::POST, "/decide", 200, answer.clone());
  ground
    .scratch
    .run(
      "INSERT INTO laya_health (state, model) VALUES ('up', $1)",
      vec![format!("output-decide=checkpoints/output-format/real-1-hand/step-000152, {GATE_KEY}=checkpoints/output-format/real-2-fold/step-000048").into()],
    )
    .await
    .unwrap();

  ground.gateway.answers(vec![completion("FOLD")]);
  decided(&ground.stages, 7, &long_part()).await;
  gate_stages::laya::settled().await;

  assert_eq!(fold_asked(&stub), *learnt);

  // With no check made, the gate's own wording is asked.
  let stub = crate::stub::Stub::start().await;
  let own = crate::ground("fold-own", Some(&stub), Default::default()).await;

  stub.answer(axum::http::Method::POST, "/decide", 200, answer);
  own.gateway.answers(vec![completion("FOLD")]);
  decided(&own.stages, 7, &long_part()).await;
  gate_stages::laya::settled().await;

  assert_eq!(fold_asked(&stub), gate_policy::laya::QUESTIONS.fold);
}
