//! The old archive's eleven gate tables moved into the store (TODO #1923): the mapping, the refusal of a
//! store already holding rows, the dry run, and the count-and-sample compare.

use std::path::Path;

use sea_orm::{ConnectionTrait, DbBackend, Statement};

use crate::scratch::Scratch;

/// The ten tables, each with the row its fixture writes, or none.
fn export() -> [(&'static str, &'static str, &'static [&'static str]); 10] {
  [
    (
      "gate_options",
      r#"{"key":"input","agent":"bmo","thinking":1,"answer_tokens":800,"timeout_ms":1000,"set_at":1791866256,"enabled":1,"laya_mode":null,"laya_tau":null,"laya_fallback":null,"rowid":1}"#,
      &["\"key\"", "\"agent\""],
    ),
    (
      "gate_roads",
      r#"{"id":1,"stage":"input","chat_id":1,"message_id":2,"provider":"claude","model":"sonnet","outcome":"answered","ms":120,"created_at":1791866256,"input_tokens":10,"output_tokens":4,"cache_read_tokens":0,"cache_write_tokens":0,"round":null,"run":null,"context_ratio":0.1,"rowid":1}"#,
      &["\"id\""],
    ),
    (
      "judgements",
      r#"{"id":1,"chat_id":1,"message_id":2,"stage":"input","verdict":"pass","detail":null,"created_at":1791866256,"ms":12,"round":null,"rowid":1}"#,
      &["\"id\""],
    ),
    (
      "laya_health",
      r#"{"id":1,"state":"ready","model":"laya","device":"cuda","vram_bytes":100,"load_ms":20,"versions":"{}","check_ms":2,"checked_at":1791866256,"healthy_at":1791866256,"address":"127.0.0.1:7431","rowid":1}"#,
      &["\"id\""],
    ),
    ("laya_verdicts", "", &["\"id\""]),
    ("reference_offers", "", &["\"id\""]),
    ("reference_verdicts", "", &["\"id\""]),
    (
      "document_translations",
      r#"{"document":"one","version":"1","target":"ko","part":1,"parts":2,"text":"번역","failed":0,"translated_at":1791866256,"rowid":1}"#,
      &["\"document\"", "\"target\"", "\"version\"", "\"part\""],
    ),
    ("format_cases", "", &["\"id\""]),
    (
      "web_gate_chats",
      r#"{"id":1,"stage":"input","user_name":"ahas","prompt":"hello","answer":"hi","ms":10,"created_at":1791866256,"user_id":1,"rowid":1}"#,
      &["\"id\""],
    ),
  ]
}

fn write(folder: &Path) -> Vec<(&'static str, u64)> {
  let tables = export();
  let mut manifest = Vec::new();
  let mut counts = Vec::new();
  for (source, row, key) in tables {
    let count = if row.is_empty() { 0 } else { 1 };
    counts.push((source, count));
    manifest.push(format!(
      r#"{{"source":"{source}","file":"{source}.ndjson","count":{count},"key":[{key}]}}"#,
      key = key.join(",")
    ));
    let body = if row.is_empty() { String::new() } else { format!("{row}\n") };
    std::fs::write(folder.join(format!("{source}.ndjson")), body).expect("the rows are written");
  }
  let said = format!(
    r#"{{"snapshot":"23569140:23569140:","readAt":"2026-10-21T16:59:44+09:00","tables":[{}]}}"#,
    manifest.join(",")
  );
  std::fs::write(folder.join("manifest.json"), said).expect("the manifest is written");

  counts
}

#[tokio::test]
async fn the_ten_tables_are_moved_and_compared() {
  let folder = tempfile::tempdir().expect("a scratch folder");
  let counts = write(folder.path());
  let scratch = Scratch::new().await;

  let report = gate_store::import::run(&scratch.address(), folder.path(), false)
    .await
    .expect("the import runs");

  let expected: u64 = counts.iter().map(|(_, count)| count).sum();
  assert_eq!(report.tables.len(), 10);
  assert_eq!(report.tables.iter().map(|table| table.written).sum::<u64>(), expected);
  assert_eq!(report.sample.checked as u64, expected);
  assert_eq!(report.sample.failures, Vec::<String>::new());

  let options = scratch
    .db()
    .query_one(Statement::from_string(
      DbBackend::Postgres,
      "SELECT agent, answer_tokens FROM gate_options WHERE key = 'input'".to_owned(),
    ))
    .await
    .expect("the options read")
    .expect("a row");
  assert_eq!(options.try_get_by_index::<String>(0).unwrap(), "bmo");
  assert_eq!(options.try_get_by_index::<Option<i64>>(1).unwrap(), Some(800));
}

#[tokio::test]
async fn a_dry_run_writes_nothing() {
  let folder = tempfile::tempdir().expect("a scratch folder");
  write(folder.path());
  let scratch = Scratch::blank().await;

  gate_store::import::run(&scratch.address(), folder.path(), true)
    .await
    .expect("the dry run runs");

  assert_eq!(scratch.count("SELECT COUNT(*) FROM gate_options", Vec::new()).await, 0);
}

#[tokio::test]
async fn a_store_holding_rows_is_refused() {
  let folder = tempfile::tempdir().expect("a scratch folder");
  write(folder.path());
  let scratch = Scratch::new().await;

  gate_store::import::run(&scratch.address(), folder.path(), false)
    .await
    .expect("the first import runs");
  let refused = gate_store::import::run(&scratch.address(), folder.path(), false)
    .await
    .expect_err("the second is refused");
  assert!(refused.contains("already holds rows"), "{refused}");
  assert!(refused.contains("gate_options holds 1"), "{refused}");
}
