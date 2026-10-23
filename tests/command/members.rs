//! The evaluation set's members: each registers itself and reads its words, each brief shows the gate's real
//! request as the gate's own code builds it, and each answer is read the way the gate's caller reads it.

use std::sync::Arc;

use gate_command::gate_eval::gates::members;
use gate_command::gate_eval::member::{Ask, EvalGate};
use gate_policy::prompts;
use serde_json::{Value, json};

use crate::ground;

/// A road that answers every request with the one answer given.
fn answering(answer: Option<&'static str>) -> Ask {
  Arc::new(move |_| Box::pin(async move { answer.map(str::to_owned) }))
}

fn member(stage: &str) -> &'static dyn EvalGate {
  members()
    .into_iter()
    .find(|member| member.stage() == stage)
    .unwrap_or_else(|| panic!("no member {stage}"))
}

#[test]
fn every_gate_of_the_set_is_a_member_once_in_name_order_and_its_words_read() {
  let stages: Vec<&str> = members().iter().map(|member| member.stage()).collect();

  assert_eq!(stages, ["document-seek", "people-standing", "session-summary", "translator"]);
  assert!(members().iter().all(|member| !member.topics().is_empty() && member.batch_size() > 0));
}

#[tokio::test]
async fn each_brief_shows_the_gate_s_real_request_for_its_example() {
  let ground = ground("briefs").await;
  let brief = |stage: &'static str| {
    let stages = ground.stages.clone();

    async move { member(stage).brief(&stages).await.unwrap() }
  };
  let seek = brief("document-seek").await;
  let standing = brief("people-standing").await;
  let summary = brief("session-summary").await;
  let translator = brief("translator").await;

  assert!(seek.starts_with("THE GATE: document-seek."));
  assert!(seek.contains("SYSTEM PROMPT THE GATE IS GIVEN:\n"));
  assert!(seek.contains("INDEX:\n"));
  assert!(seek.ends_with("though entries look close."));
  assert!(standing.contains("the document-writing rulebook\n\nthe plain-writing rulebook"));
  assert!(standing.contains("Part: room-only\nChat id: -1001234567"));
  assert!(standing.contains("[rooms/-1001234567/people/chunks/p4169-address.md]"));
  assert!(!standing.contains("{form_rule}"));
  assert!(summary.contains("SYSTEM PROMPT THE GATE IS GIVEN:\nthe recollection rulebook\n\n"));
  assert!(summary.contains("the-chat-agent (room -1001234567): "));
  assert!(summary.contains("WORKER INSTRUCTIONS:\nthe recollection rulebook"));
  assert!(translator.contains(prompts::instructions("translator").unwrap()));
  assert!(translator.contains("the plain-writing rulebook\n\n"));
  assert!(
    translator
      .contains("PROMPT THE GATE IS GIVEN (for the example input):\nTranslate into English.\n\n## ")
  );

  for one in [&seek, &standing, &summary, &translator] {
    assert!(!one.contains("BMO") && !one.contains("\u{be44}\u{baa8}"), "an agent's name in a brief");
  }
}

#[tokio::test]
async fn document_seek_passes_on_a_right_first_pick_and_on_none_for_a_question_nothing_answers() {
  let ground = ground("member-seek").await;
  let seek = member("document-seek");
  let input = json!({
    "mode": "headings",
    "entries": [
      { "slug": "h1", "line": "deploy > rollback", "group": null },
      { "slug": "h2", "line": "deploy > units", "group": null },
      { "slug": "h3", "line": "setup", "group": null },
    ],
    "question": "deploy rollback",
  });
  let key = |slugs: &[&str]| json!({ "slugs": slugs });
  let run = |key: Value, answer: Option<&'static str>| {
    let stages = ground.stages.clone();
    let input = input.clone();

    async move { seek.run(&stages, &input, &key, &answering(answer)).await }
  };

  assert!(run(key(&["h1"]), Some("h1\nh2")).await.pass);
  assert!(!run(key(&["h1"]), Some("h2")).await.pass);
  assert!(run(key(&[]), Some("none")).await.pass);
  assert!(!run(key(&[]), None).await.answered);
  assert_eq!(seek.refusal(&input, &key(&["z"])).as_deref(), Some("a key slug not in the index"));

  let branches = json!({ "mode": "branches", "entries": input["entries"], "question": "q" });

  assert_eq!(seek.refusal(&branches, &key(&[])).as_deref(), Some("a branch index answered none"));
}

#[tokio::test]
async fn a_sheet_the_summariser_s_own_check_refuses_scores_nothing() {
  let ground = ground("member-standing").await;
  let standing = member("people-standing");
  let input = json!({
    "layer": "common", "chatId": -1, "userId": 7,
    "pieces": [{ "slug": "c7-speech", "text": "## Facts\n- [date 2026-01-02] Likes tea." }],
  });
  let key = json!({ "facts": [{ "accept": ["tea"] }], "avoid": ["coffee"] });
  let kept = standing.run(&ground.stages, &input, &key, &answering(Some("## Speech\n- tea"))).await;
  let foreign = standing.run(&ground.stages, &input, &key, &answering(Some("## Address\n- tea"))).await;

  assert!(kept.pass);
  assert!(!foreign.pass);
  assert_eq!(foreign.checks, 1);

  let other = |layer: &str, slug: &str| json!({ "layer": layer, "chatId": -1, "userId": 7, "pieces": [{ "slug": slug, "text": "t" }] });

  assert_eq!(standing.refusal(&other("common", "c7-speech"), &key), None);
  assert!(standing.refusal(&other("room", "c7-speech"), &key).is_some());
  assert!(standing.refusal(&other("common", "c8-speech"), &key).is_some());
}

#[tokio::test]
async fn a_note_is_held_to_its_key_or_to_saying_none() {
  let ground = ground("member-summary").await;
  let summary = member("session-summary");
  let input = json!({
    "kind": "chat",
    "turns": [{ "who": "room", "room": "-1", "lines": ["[t] Mia (id 1): the meeting is at 3"] }],
  });
  let carried = json!({ "none": false, "facts": [{ "accept": ["meeting"] }], "avoid": [] });
  let none = json!({ "none": true, "facts": [], "avoid": [] });

  assert!(
    summary
      .run(&ground.stages, &input, &carried, &answering(Some("The meeting is at 3.")))
      .await
      .pass
  );
  assert!(!summary.run(&ground.stages, &input, &carried, &answering(Some("none"))).await.pass);
  assert!(summary.run(&ground.stages, &input, &none, &answering(Some(" NONE "))).await.pass);
  assert_eq!(
    summary
      .refusal(&input, &json!({ "none": true, "facts": [{ "accept": ["x"] }], "avoid": [] }))
      .as_deref(),
    Some("a key that neither carries nor is none")
  );
}

#[tokio::test]
async fn a_translation_keeps_its_structure_and_meets_its_key() {
  let ground = ground("member-translator").await;
  let translator = member("translator");
  let input = json!({ "variant": "viewer", "target": "en", "text": "## Steps\n\nrun `make`" });
  let key =
    json!({ "keep": ["`make`"], "render": [{ "source": "run", "accept": ["run"] }], "avoid": ["Here is"] });

  assert!(
    translator
      .run(&ground.stages, &input, &key, &answering(Some("## Steps\n\nrun `make`")))
      .await
      .pass
  );

  let flat = translator.run(&ground.stages, &input, &key, &answering(Some("Steps: run make"))).await;

  assert_eq!(
    flat.misses,
    ["structure changed: The translation did not keep the part's headings: 2:1 became none."]
  );
  assert!(flat.answered);
  assert_eq!(
    translator
      .refusal(&json!({ "variant": "worker", "target": "ko", "text": "x" }), &key)
      .as_deref(),
    Some("worker translates into en only")
  );
}

#[test]
fn the_translator_s_cases_stand_by_its_own_reading() {
  let translator = member("translator");
  let cases = translator.cases();

  assert!(!cases.is_empty());

  for case in &cases {
    assert!(case.id.contains("case"));
    assert_eq!(translator.refusal(&case.input, &case.key), None, "{}", case.id);
  }
}
