//! The console's calls: the gate order, a gate's options read and changed, Laya beside the probed gates, a room's
//! judgements with their roads and offers, trials, and the documents' seeker and translations.

use gate_runs::records::now;
use reqwest::StatusCode;
use serde_json::json;

use crate::{ROOM, ground, refused};

#[tokio::test]
async fn the_gate_order_is_served_with_each_gates_profile() {
  let ground = ground("gates", |_| None).await;
  let (status, body) = ground.get("/gates").await;

  assert_eq!(status, StatusCode::OK);

  let gates = body["gates"].as_array().unwrap();
  let sanitizer = gates.iter().find(|gate| gate["key"] == "sanitizer").expect("the sanitizer");

  assert!(["pre", "post", "apart"].contains(&sanitizer["part"].as_str().unwrap()));
  assert!(sanitizer["step"].is_u64());
  assert_eq!(sanitizer["laya_probe"], true);
  assert_eq!(sanitizer["default_laya_mode"], "off");

  for key in ["condition", "switchable", "answer_tokens"] {
    assert!(sanitizer.as_object().unwrap().contains_key(key), "{key}");
  }
}

#[tokio::test]
async fn a_gates_options_are_read_and_changed() {
  let ground = ground("options", |_| None).await;
  let (status, body) = ground.get("/options/sanitizer").await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body["timeout_ms"], 30_000);
  assert!(body["effective"]["laya_mode"].is_string());

  let (status, body) = ground.post("/options/sanitizer", json!({ "timeout_ms": 20_000 })).await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body["key"], "sanitizer");
  assert_eq!(body["options"]["timeout_ms"], 20_000);
  assert_eq!(body["options"]["provider"], "registry");

  let (status, body) = ground.post("/options/sanitizer", json!({ "thinking": true })).await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&body, "own_llm");

  let (status, body) = ground.get("/options/no-such-gate").await;

  assert_eq!(status, StatusCode::NOT_FOUND);
  refused(&body, "no_gate");
}

#[tokio::test]
async fn a_mode_the_gate_cannot_run_in_is_refused_with_its_reason() {
  let ground = ground("mode", |_| None).await;
  let (status, body) = ground
    .post("/options/sanitizer", json!({ "laya_mode": "filter", "laya_tau": 0.9 }))
    .await;

  assert_eq!(status, StatusCode::CONFLICT, "{body}");
  assert_eq!(body["code"], "laya_mode_refused");
  assert_eq!(body["reason"], "no_checkpoint");
  assert!(body["error"].is_string());
}

#[tokio::test]
async fn laya_is_read_beside_every_probed_gate() {
  let ground = ground("laya", |_| None).await;
  let (status, body) = ground.get("/laya").await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body["health"]["state"], "unknown");
  assert_eq!(body["modes"], json!(["off", "shadow", "filter", "asymmetric"]));
  assert_eq!(body["taus"].as_array().unwrap().len(), 7);

  let sanitizer = body["gates"]
    .as_array()
    .unwrap()
    .iter()
    .find(|gate| gate["stage"] == "sanitizer")
    .cloned()
    .unwrap();

  assert_eq!(sanitizer["mode"], "off");
  assert_eq!(sanitizer["checkpoint"], json!(null));
  assert_eq!(sanitizer["agreement"], json!(null));
  assert!(
    sanitizer["refused"]
      .as_array()
      .unwrap()
      .iter()
      .any(|one| one["code"] == "no_checkpoint"),
    "{sanitizer}"
  );
}

#[tokio::test]
async fn a_rooms_judgements_come_a_page_at_a_time_with_their_roads_and_offers() {
  let ground = ground("rooms", |_| None).await;
  let at = now();

  ground
    .scratch
    .run(
      r#"INSERT INTO judgements (chat_id, message_id, stage, verdict, created_at, ms, round) VALUES
           (7, 9, 'sanitizer', 'CLEAN', $1, 2000, 'round-1'),
           (7, 10, 'sanitizer', 'CLEAN', $1, 1000, 'round-2'),
           (8, 11, 'sanitizer', 'CLEAN', $1, 1000, 'round-3')"#,
      vec![at.into()],
    )
    .await
    .unwrap();
  ground
    .scratch
    .run(
      r#"INSERT INTO gate_roads (stage, chat_id, message_id, provider, model, outcome, ms, created_at, input_tokens, output_tokens, round) VALUES
           ('sanitizer', 7, 9, 'registry', 'a-registration', 'answered', 1900, $1, 120, 8, 'round-1'),
           ('sanitizer', 7, 10, 'registry', 'a-registration', 'answered', 900, $1, NULL, NULL, 'round-2'),
           ('sanitizer', 7, 10, 'registry', 'a-registration', 'answered', 900, $2, NULL, NULL, 'round-2')"#,
      vec![(at - 1).into(), (at - 600).into()],
    )
    .await
    .unwrap();
  ground
    .scratch
    .run(
      r#"INSERT INTO reference_offers (stage, chat_id, message_id, held, asked, by_item, by_keyword, by_person, capped, slugs, created_at, round, rules)
           VALUES ('library-knowledge', 7, 9, 4, 2, 0, 2, 0, 0, '["a","b"]', $1, 'round-1', '["keyword"]')"#,
      vec![at.into()],
    )
    .await
    .unwrap();

  let (status, body) = ground.get(&format!("/rooms/{ROOM}/judgements?limit=1")).await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body["has_more"], true);

  let newest = &body["judgements"][0];

  assert_eq!((&newest["message"], &newest["round"]), (&json!(10), &json!("round-2")));
  assert_eq!(newest["roads"].as_array().unwrap().len(), 1, "{newest}");
  assert_eq!(newest["roads"][0]["tokens"], json!(null));
  assert_eq!(newest["offers"], json!([]));

  let before = newest["id"].as_i64().unwrap();
  let (status, body) = ground.get(&format!("/rooms/{ROOM}/judgements?before={before}")).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(body["has_more"], false);

  let older = &body["judgements"][0];

  assert_eq!(older["roads"][0]["tokens"]["input_tokens"], 120);
  assert_eq!(
    older["offers"],
    json!([{ "stage": "library-knowledge", "held": 4, "asked": 2, "kept": { "item": 0, "keyword": 2, "person": 0 }, "capped": 0, "rules": ["keyword"] }])
  );

  let (status, body) = ground.get(&format!("/rooms/{ROOM}/judgements?limit=many")).await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&body, "field_wrong");
}

#[tokio::test]
async fn a_trial_is_kept_and_read_back() {
  let ground = ground("trials", |_| Some("CLEAN".into())).await;
  let (status, body) = ground
    .post(
      "/trials",
      json!({ "stage": "sanitizer", "prompt": "Plain words.", "user": "the-owner" }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(
    (&body["stage"], &body["user"], &body["prompt"]),
    (&json!("sanitizer"), &json!("the-owner"), &json!("Plain words."))
  );
  assert_eq!(body["answer"], "CLEAN");
  assert_eq!(ground.scratch.count("SELECT count(*) FROM judgements", vec![]).await, 0);

  let (status, read) = ground.get("/trials/sanitizer?limit=5").await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(read["trials"], json!([body]));

  let (status, body) = ground
    .post(
      "/trials",
      json!({ "stage": "sanitizer", "prompt": "a".repeat(1_000_001), "user": "the-owner" }),
    )
    .await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&body, "prompt_too_long");

  let (status, body) = ground.get("/trials/no-such-gate").await;

  assert_eq!(status, StatusCode::NOT_FOUND);
  refused(&body, "no_gate");
}

#[tokio::test]
async fn the_seeker_picks_the_documents_a_question_calls_for() {
  let ground = ground("sought", |_| Some("deploys".into())).await;
  let entries = json!([{ "slug": "deploys", "line": "how a deploy goes" }, { "slug": "kittens", "line": "the office cat", "group": "office" }]);
  let (status, body) = ground
    .post("/documents/sought", json!({ "question": "How do deploys go?", "entries": entries }))
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(body, json!({ "picks": ["deploys"] }));

  let silent = crate::ground("unsought", |_| None).await;
  let (status, body) = silent
    .post("/documents/sought", json!({ "question": "How do deploys go?", "entries": entries }))
    .await;

  assert_eq!(status, StatusCode::BAD_GATEWAY);
  refused(&body, "no_answer");
}

#[tokio::test]
async fn a_documents_translation_is_queued_and_read_back() {
  let ground = ground("document-translations", |_| Some("Translated.".into())).await;
  let (status, body) = ground
    .post(
      "/documents/translations",
      json!({ "document": "docs/deploys.md", "version": "v1", "target": "ko", "parts": 1, "wanted": [{ "part": 0, "text": "How a deploy goes." }] }),
    )
    .await;

  assert_eq!(status, StatusCode::ACCEPTED, "{body}");
  assert_eq!(body, json!({ "taken": 1 }));

  let (status, body) = ground.get("/documents/translations/state?document=docs/deploys.md&target=ko").await;

  assert_eq!(status, StatusCode::OK);
  assert!(body["pending"].is_u64() && body.as_object().unwrap().contains_key("failure"), "{body}");

  let (status, body) = ground
    .get("/documents/translations/parts?document=docs/deploys.md&version=v1&target=ko")
    .await;

  assert_eq!(status, StatusCode::OK);
  assert!(body["parts"].is_array());

  let (status, body) = ground
    .post(
      "/documents/translations",
      json!({ "document": "deploys", "version": "v1", "target": "ko", "parts": 1, "wanted": [] }),
    )
    .await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&body, "document_unknown");

  let (status, body) = ground.get("/documents/translations/state?document=docs/deploys.md&target=fr").await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&body, "language_unknown");
}
