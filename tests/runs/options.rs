//! A gate's options: no gate stands in the order, so a change names no gate and is refused, and a companion's
//! rows are the chat agent's copied as they stand.

use gate_codes::Code;
use gate_runs::options::{self, Refusal, copy, timeout_ms};
use serde_json::json;

use crate::{ground, runs_of};

fn refused(result: Result<(), Refusal>) -> Code {
  result.unwrap_err().code
}

#[test]
fn no_key_is_a_gate_of_the_order() {
  assert!(!options::is_gate("output-format"));
  assert!(!options::is_gate("session-summary"));
  assert!(!options::is_gate("translate"));
}

#[tokio::test]
async fn a_change_to_a_gate_that_stands_nowhere_is_refused_no_gate() {
  let (scratch, agency, gateway) = ground().await;
  let runs = runs_of(&scratch, &agency, &gateway);

  assert_eq!(
    refused(options::change(&runs, "output-format", &json!({ "timeoutMs": 5000 }), 1).await),
    Code::NoGate
  );
  assert_eq!(
    refused(options::change(&runs, "session-summary", &json!({ "enabled": true }), 1).await),
    Code::NoGate
  );
}

#[tokio::test]
async fn a_companions_options_are_the_chat_agents_rows_copied_as_they_stand() {
  let (scratch, agency, gateway) = ground().await;
  let _ = runs_of(&scratch, &agency, &gateway);

  for (key, ms) in [("a-gate", 15_000), ("another-gate", 25_000)] {
    scratch
      .run(
        r#"INSERT INTO gate_options ("key", "agent", "timeout_ms", "set_at") VALUES ($1, 'the-chat-agent', $2, 1)"#,
        vec![key.into(), ms.into()],
      )
      .await
      .unwrap();
  }

  copy(scratch.db(), "a-companion", "the-chat-agent", 77).await.unwrap();

  assert_eq!(timeout_ms(scratch.db(), "a-gate", "a-companion").await.unwrap(), Some(15_000));
  assert_eq!(timeout_ms(scratch.db(), "another-gate", "a-companion").await.unwrap(), Some(25_000));

  // An agent with no rows copies nothing.
  copy(scratch.db(), "a-companion", "an-agent-with-no-rows", 78).await.unwrap();

  assert_eq!(
    scratch
      .count("SELECT count(*) FROM gate_options WHERE agent = 'a-companion' AND set_at = 77", vec![])
      .await,
    2
  );
}
