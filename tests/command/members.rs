//! The evaluation set's members: each registers itself and reads its words, each brief shows the gate's real
//! request as the gate's own code builds it, and each answer is read the way the gate's caller reads it.

use std::sync::Arc;

use gate_command::gate_eval::gates::members;
use gate_command::gate_eval::member::{Ask, EvalGate};
use serde_json::json;

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

  assert_eq!(stages, ["session-summary"]);
  assert!(members().iter().all(|member| !member.topics().is_empty() && member.batch_size() > 0));
}

#[tokio::test]
async fn each_brief_shows_the_gate_s_real_request_for_its_example() {
  let ground = ground("briefs").await;
  let brief = |stage: &'static str| {
    let stages = ground.stages.clone();

    async move { member(stage).brief(&stages).await.unwrap() }
  };
  let summary = brief("session-summary").await;

  assert!(summary.contains("SYSTEM PROMPT THE GATE IS GIVEN:\nthe recollection rulebook\n\n"));
  assert!(summary.contains("the-chat-agent (room -1001234567): "));
  assert!(summary.contains("WORKER INSTRUCTIONS:\nthe recollection rulebook"));
  assert!(
    !summary.contains("BMO") && !summary.contains("\u{be44}\u{baa8}"),
    "an agent's name in a brief"
  );
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
