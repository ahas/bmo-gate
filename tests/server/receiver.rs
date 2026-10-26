//! A turn's reference, words through the sanitiser, a room's judgements written and a round's put under its
//! answer, and a companion's options copied.

use gate_runs::records::now;
use reqwest::StatusCode;
use serde_json::{Value, json};

use crate::{ROOM, ground, picking};

#[tokio::test]
async fn a_turn_is_handed_the_reference_its_envelope_calls_for() {
  let ground = ground("reference", picking(&["deploy-notes"])).await;

  ground.furnish();

  let (status, body) = ground
    .post(
      "/reference/selected",
      json!({
        "roomId": ROOM,
        "messageId": 9,
        "lines": ["Owner (id 5): how do deploys go?"],
        "speakerIds": [5],
        "round": "round-1",
        "peopleSpoke": true,
        "offGates": [],
        "records": true,
      }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");

  let entries = body["entries"].as_array().unwrap();
  let deploy = entries
    .iter()
    .find(|entry| entry["path"] == "knowledge/deploy-notes.md")
    .expect("the deploy note");

  assert_eq!(deploy["source"], "knowledge");
  assert_eq!(deploy["text"], "Deploys go through the testbed.");
  assert!(entries.iter().all(|entry| entry.get("fragment").is_none()), "{body}");
  assert!(ground.scratch.count("SELECT count(*) FROM reference_offers", vec![]).await > 0);
}

#[tokio::test]
async fn a_turn_with_a_situation_and_holds_is_read_with_them() {
  let ground = ground("situation", |_| None).await;
  let (status, body) = ground
    .post(
      "/reference/selected",
      json!({
        "roomId": ROOM,
        "lines": ["Owner (id 5): good morning"],
        "speakerIds": [5],
        "situation": { "agentName": "the-chat-agent", "roomKind": "owner", "events": [{ "kind": "morning" }, { "kind": "item-due", "itemId": 12 }], "nowAt": 1_700_000_000_000_i64 },
        "holds": ["quiet"],
        "peopleSpoke": true,
        "answered": "Good morning.",
        "offGates": ["library-knowledge"],
        "lore": false,
        "records": false,
      }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert!(body["entries"].is_array());
  assert_eq!(ground.scratch.count("SELECT count(*) FROM reference_offers", vec![]).await, 0);
}

#[tokio::test]
async fn words_with_nothing_worth_judging_come_back_as_they_are() {
  let ground = ground("sanitised", |_| None).await;
  let (status, body) = ground
    .post(
      "/sanitised",
      json!({ "text": "Plain words about lunch.", "label": "a room's message", "roomId": ROOM, "messageId": 9 }),
    )
    .await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body, json!({ "text": "Plain words about lunch.", "changed": false }));
}

#[tokio::test]
async fn a_judgement_is_written_as_it_comes_and_told_to_the_stream() {
  let ground = ground("judgement", |_| None).await;
  let mut heard = ground.app.stages.events.subscribe();
  let (status, body) = ground
    .post(
      "/judgements",
      json!({ "roomId": ROOM, "messageId": 9, "gateName": "chat", "verdict": "SKIP", "detail": "nothing to say", "ms": 1200, "round": "round-1" }),
    )
    .await;

  assert_eq!(status, StatusCode::CREATED, "{body}");
  assert_eq!(body["roomId"], ROOM);
  assert_eq!(body["gateName"], "chat");

  let event = heard.recv().await.unwrap();

  assert_eq!(event.kind, "judgement.created");
  assert_eq!(
    (
      &event.data["roomId"],
      &event.data["gateName"],
      &event.data["verdict"],
      &event.data["round"]
    ),
    (&json!(ROOM), &json!("chat"), &json!("SKIP"), &json!("round-1"))
  );

  let (status, _) = ground
    .post("/judgements", json!({ "roomId": ROOM, "gateName": "chat", "verdict": "ANSWER" }))
    .await;

  assert_eq!(status, StatusCode::CREATED);
  assert_eq!(
    ground.scratch.count("SELECT count(*) FROM judgements WHERE chat_id = 7", vec![]).await,
    2
  );
  assert_eq!(body.as_object().unwrap().get("roads"), Some(&Value::Array(vec![])));
  assert_eq!(body["lines"], json!([]));
}

#[tokio::test]
async fn the_attach_puts_a_rounds_judgements_under_the_message_that_answered_it() {
  let ground = ground("attach", |_| None).await;

  ground
    .scratch
    .run(
      r#"INSERT INTO judgements (chat_id, stage, verdict, created_at) VALUES (7, 'chat', 'SKIP', 100), (8, 'chat', 'SKIP', $1)"#,
      vec![now().into()],
    )
    .await
    .unwrap();

  for verdict in ["RE-ASK", "ANSWER"] {
    let (status, _) = ground
      .post("/judgements", json!({ "roomId": ROOM, "gateName": "chat", "verdict": verdict }))
      .await;

    assert_eq!(status, StatusCode::CREATED);
  }

  let (status, body) = ground
    .post(
      "/judgements/attached",
      json!({ "roomId": ROOM, "messageId": 12, "since": now() - 60_000 }),
    )
    .await;

  assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
  assert_eq!(
    ground
      .scratch
      .count("SELECT count(*) FROM judgements WHERE message_id = 12", vec![])
      .await,
    2
  );
  assert_eq!(
    ground
      .scratch
      .count("SELECT count(*) FROM judgements WHERE message_id IS NULL", vec![])
      .await,
    2
  );
}

#[tokio::test]
async fn a_companion_is_handed_the_chat_agents_options() {
  let ground = ground("copied", |_| None).await;
  let (status, body) = ground
    .post(
      "/options/copied",
      json!({ "agentName": "a-companion", "fromAgentName": "the-chat-agent" }),
    )
    .await;

  assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

  let copied = ground
    .scratch
    .count("SELECT count(*) FROM gate_options WHERE agent = 'a-companion'", vec![])
    .await;
  let standing = ground
    .scratch
    .count("SELECT count(*) FROM gate_options WHERE agent = 'the-chat-agent'", vec![])
    .await;

  assert_eq!(copied, standing);

  let (status, _) = ground
    .post("/options/copied", json!({ "agentName": "another", "fromAgentName": "nobody-at-all" }))
    .await;

  assert_eq!(status, StatusCode::NO_CONTENT);
}
