//! The bounded tables held to their bound: a format case and a sanitiser's verdict past ninety days are swept, and
//! a younger one stays.

use gate_stages::retention::{FORMAT_CASES_MS, SANITISED_MS, sweep};

use crate::ground;

#[tokio::test]
async fn rows_past_their_bound_are_swept_and_younger_ones_stay() {
  let ground = ground("retention", None, Default::default()).await;
  let now = 1_800_000_000_i64;
  let scratch = &ground.scratch;

  for at in [now - FORMAT_CASES_MS - 1, now - 60] {
    scratch
      .run(
        r#"INSERT INTO format_cases (at, stage, attempt, reason, text, markup) VALUES ($1, 'output-format', 1, 'r', 't', 'm')"#,
        vec![at.into()],
      )
      .await
      .unwrap();
  }

  for (hash, at) in [("old", now - SANITISED_MS - 1), ("new", now - 60)] {
    scratch
      .run(
        r#"INSERT INTO sanitised_texts (hash, text, changed, at, judged_at) VALUES ($1, 't', 0, 'a room', $2)"#,
        vec![hash.into(), at.into()],
      )
      .await
      .unwrap();
  }

  let swept = sweep(scratch.db(), now).await.unwrap();

  assert_eq!(swept, [("format_cases", 1), ("sanitised_texts", 1)]);
  assert_eq!(scratch.count("SELECT count(*) FROM format_cases", vec![]).await, 1);
  assert_eq!(scratch.texts("SELECT hash FROM sanitised_texts", vec![]).await, ["new"]);
}
