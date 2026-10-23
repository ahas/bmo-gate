//! A gate's options: the mode it actually runs in, its defaults, each change taken or refused with its code, the
//! screen's view of them, and a companion's copied from the chat agent's.

use gate_codes::Code;
use gate_policy::profiles::PROFILES;
use gate_runs::options::{self, Refusal, change, copy, defaults, effective_mode, timeout_ms, view};
use serde_json::{Value, json};

use crate::fakes::{mapping, provider};
use crate::{ground, runs_of, wait};

fn of(key: &str) -> &'static gate_policy::profiles::Profile {
  PROFILES.of(key).unwrap()
}

#[test]
fn a_gate_runs_off_without_a_probe_and_in_shadow_where_laya_would_decide_unfounded() {
  assert_eq!(effective_mode(of("translator"), Some("filter"), Some(0.9)), "off");
  assert_eq!(effective_mode(of("system-documents"), None, None), "shadow");
  assert_eq!(effective_mode(of("system-documents"), Some("filter"), None), "shadow");
  assert_eq!(effective_mode(of("system-documents"), Some("filter"), Some(0.9)), "filter");
  assert_eq!(effective_mode(of("system-documents"), Some("asymmetric"), Some(0.9)), "shadow");
  assert_eq!(effective_mode(of("sanitizer"), Some("asymmetric"), Some(0.9)), "asymmetric");
}

#[test]
fn the_defaults_carry_the_gates_own_answer_room_and_mode() {
  assert_eq!(defaults(of("voice-polish")).answer_tokens, 8192);
  assert_eq!(defaults(of("system-documents")).laya_mode, "shadow");
  assert_eq!(defaults(of("translator")).laya_mode, "off");
  assert_eq!(defaults(of("room-rules")).answer_tokens, options::DEFAULT_ANSWER_TOKENS);
}

type Refused = Code;

fn refused(result: Result<(), Refusal>) -> Refused {
  result.unwrap_err().code
}

#[tokio::test]
async fn a_change_is_refused_with_the_code_that_says_why() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);
  let at = 5;

  agency.providers.lock().unwrap().push(provider("claude-code", false));

  let cases: [(&str, Value, Refused); 11] = [
    ("no-such-gate", json!({ "timeoutMs": 5000 }), Code::NoGate),
    ("room-rules", json!({ "thinking": true }), Code::OwnLlm),
    ("room-rules", json!({}), Code::NothingToChange),
    (
      "room-rules",
      json!({ "layaFallback": "a-provider-nobody-has" }),
      Code::LayaFallbackUnknown,
    ),
    ("room-rules", json!({ "enabled": "yes" }), Code::SwitchNotBoolean),
    ("room-rules", json!({ "enabled": false }), Code::AlwaysOn),
    ("room-rules", json!({ "timeoutMs": 999 }), Code::TimeoutOutOfRange),
    ("room-rules", json!({ "layaMode": "loud" }), Code::LayaModeUnknown),
    ("room-rules", json!({ "layaTau": 1.5 }), Code::LayaTauOutOfRange),
    ("translator", json!({ "layaMode": "shadow" }), Code::NoProbe),
    ("room-rules", json!({ "layaMode": "asymmetric", "layaTau": 0.9 }), Code::NoSafeVerdict),
  ];

  for (key, body, expected) in cases {
    assert_eq!(refused(change(&runs, key, &body, at).await), expected, "{key} {body}");
  }

  assert_eq!(
    refused(change(&runs, "room-rules", &json!({ "layaMode": "filter", "layaTau": 0.9 }), at).await),
    Code::NoCheckpoint
  );

  scratch
    .run(
      "INSERT INTO laya_health (state, model) VALUES ('up', 'room-rules=/weights/room-rules, sanitizer=/weights/sanitizer')",
      vec![],
    )
    .await
    .unwrap();

  assert_eq!(
    refused(change(&runs, "room-rules", &json!({ "layaMode": "filter" }), at).await),
    Code::NeedsTau
  );
  assert_eq!(options::checkpoints(scratch.db()).await.unwrap(), ["room-rules", "sanitizer"]);
  change(&runs, "room-rules", &json!({ "layaMode": "filter", "layaTau": 0.9 }), at)
    .await
    .unwrap();
  assert_eq!(scratch.count("SELECT count(*) FROM gate_options", vec![]).await, 1);
}

#[tokio::test]
async fn each_field_is_written_on_its_own_for_the_chat_agent_and_read_back_by_the_screen() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("registry", true));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("registry".into(), mapping("registry", "a-registration", Some("thinking"), Some(4000)));
  wait(&runs, "voice-polish", 20_000).await;
  change(&runs, "voice-polish", &json!({ "enabled": false, "layaFallback": "none" }), 9)
    .await
    .unwrap();

  let shown = view(&runs, "voice-polish").await.unwrap();

  assert_eq!(shown.timeout_ms, Some(20_000));
  assert!(!shown.enabled && shown.switchable && !shown.laya_probe);
  assert_eq!(shown.laya_fallback.as_deref(), Some("none"));
  assert!(shown.effective.thinking);
  assert_eq!(shown.effective.answer_tokens, 8192);
  assert_eq!(shown.effective.laya_mode, "off");
  assert!(!options::switched_on(scratch.db(), "voice-polish", "the-chat-agent").await.unwrap());
  assert!(options::switched_on(scratch.db(), "voice-polish", "another-agent").await.unwrap());
  assert!(options::switched_on(scratch.db(), "room-rules", "the-chat-agent").await.unwrap());
  assert_eq!(
    scratch.texts("SELECT agent || ' ' || set_at::text FROM gate_options", vec![]).await,
    ["the-chat-agent 9"]
  );

  let route = options::route_view(&runs, "voice-polish").await.unwrap();

  assert_eq!(
    (route.provider.as_str(), route.model.as_str(), route.laya),
    ("registry", "a-registration", false)
  );
  assert_eq!(route.timeout_ms, Some(20_000));
}

#[tokio::test]
async fn a_companions_options_are_the_chat_agents_rows_copied_as_they_stand() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  wait(&runs, "room-rules", 15_000).await;
  wait(&runs, "sanitizer", 25_000).await;
  copy(scratch.db(), "a-companion", "the-chat-agent", 77).await.unwrap();

  assert_eq!(timeout_ms(scratch.db(), "room-rules", "a-companion").await.unwrap(), Some(15_000));
  assert_eq!(timeout_ms(scratch.db(), "sanitizer", "a-companion").await.unwrap(), Some(25_000));

  // Tuned apart afterwards: a second copy replaces what the companion held, and an agent with no rows copies
  // nothing.
  copy(scratch.db(), "a-companion", "an-agent-with-no-rows", 78).await.unwrap();

  assert_eq!(
    scratch
      .count("SELECT count(*) FROM gate_options WHERE agent = 'a-companion'", vec![])
      .await,
    2
  );
  assert_eq!(scratch.count("SELECT count(*) FROM gate_options WHERE set_at = 77", vec![]).await, 2);
}
