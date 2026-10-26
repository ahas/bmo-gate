//! `bmo-gate records` read off the gate's database: every row of a table as one JSON object a line in the order the
//! rows were written, and a name that is no table of the gate's refused as words.

use gate_command::Fault;
use gate_command::records::read;
use serde_json::Value;

use crate::scratch::Scratch;

#[tokio::test]
async fn every_row_is_one_json_object_in_the_order_written() {
  let scratch = Scratch::new().await;

  for (stage, message) in [("output-format", 7), ("session-summary", 3)] {
    scratch
      .run(
        r#"INSERT INTO judgements (chat_id, message_id, stage, verdict, created_at) VALUES (-5, $1, $2, 'NONE', 1)"#,
        vec![message.into(), stage.into()],
      )
      .await
      .unwrap();
  }

  let lines = read(scratch.db(), "judgements").await.unwrap();
  let rows: Vec<Value> = lines.iter().map(|line| serde_json::from_str(line).unwrap()).collect();

  assert_eq!(rows.len(), 2);
  assert_eq!(rows[0]["stage"], "output-format");
  assert_eq!(rows[0]["message_id"], 7);
  assert_eq!(rows[1]["stage"], "session-summary");
  assert_eq!(rows[1]["chat_id"], -5);
}

#[tokio::test]
async fn a_name_that_is_no_table_of_the_gate_is_refused() {
  let scratch = Scratch::new().await;

  assert!(matches!(read(scratch.db(), "messages").await, Err(Fault::Words(_))));
}
