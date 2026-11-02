//! A turn's reference, a room's judgements written and a round's put under its answer, and a companion's options
//! copied.

use gate_runs::records::now;
use reqwest::StatusCode;
use serde_json::{Value, json};

use super::{ROOM, ground};

#[tokio::test]
async fn a_turn_is_handed_only_what_no_gate_picks_and_no_model_is_asked() {
  let ground = ground("reference", |_| Some("yes".into())).await;

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
        "records": true,
      }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");

  let entries = body["entries"].as_array().unwrap();

  assert!(
    entries.iter().all(|entry| entry["path"] != "knowledge/deploy-notes.md"),
    "no picked piece: {body}"
  );
  assert!(ground.gateway.asked.lock().unwrap().is_empty(), "no model was asked");
  assert_eq!(ground.scratch.count("SELECT count(*) FROM reference_offers", vec![]).await, 0);
}

#[tokio::test]
async fn the_index_counts_what_the_session_read_a_piece_records_its_read_and_a_search_finds_it_by_its_words()
 {
  let ground = ground("index", |_| None).await;

  ground.furnish();

  let (status, index) = ground.get(&format!("/reference/index?room={ROOM}&session=session-a")).await;

  assert_eq!(status, StatusCode::OK, "{index}");

  let groups: Vec<&str> = index["groups"]
    .as_array()
    .unwrap()
    .iter()
    .map(|group| group["group"].as_str().unwrap())
    .collect();

  assert_eq!(groups, ["system-documents", "room-rules", "knowledge", "people", "room-memories"]);

  let knowledge = &index["groups"][2];

  assert_eq!(knowledge["unread"], 2, "{index}");
  assert_eq!(knowledge["entries"][0]["slug"], "deploy-notes");
  assert_eq!(knowledge["entries"][0]["holds"], "how a deploy goes");

  let (status, piece) = ground
    .get(&format!("/reference/pieces/deploy-notes?room={ROOM}&group=knowledge&session=session-a"))
    .await;

  assert_eq!(status, StatusCode::OK, "{piece}");
  assert_eq!(piece["text"], "Deploys go through the testbed.");

  let (_, index) = ground.get(&format!("/reference/index?room={ROOM}&session=session-a")).await;

  assert_eq!(index["groups"][2]["unread"], 1, "the piece read is counted read");

  let (status, found) = ground.get(&format!("/reference/search?q=deploy&room={ROOM}")).await;

  assert_eq!(status, StatusCode::OK, "{found}");
  assert_eq!(found["entries"][0]["slug"], "deploy-notes");
  assert_eq!(found["entries"][0]["group"], "knowledge");

  for (asked, code) in [
    (format!("/reference/pieces/no-such?room={ROOM}&group=knowledge"), StatusCode::NOT_FOUND),
    (
      format!("/reference/pieces/deploy-notes?room={ROOM}&group=no-group"),
      StatusCode::BAD_REQUEST,
    ),
    (format!("/reference/search?q=deploy&room={ROOM}&limit=25"), StatusCode::BAD_REQUEST),
  ] {
    assert_eq!(ground.get(&asked).await.0, code, "{asked}");
  }
  assert!(ground.gateway.asked.lock().unwrap().is_empty(), "no model was asked");
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
        "records": false,
      }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert!(body["entries"].is_array());
  assert_eq!(ground.scratch.count("SELECT count(*) FROM reference_offers", vec![]).await, 0);
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
