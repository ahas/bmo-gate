//! What the gate keeps no longer than its bound (`docs/boundary-api.md`, 「Its tables」): the output gate's format
//! cases (`docs/output-gate.md`, 「The case collection」) and the sanitiser's verdicts, each ninety days, swept over
//! the whole of each table.

use sea_orm::{DatabaseConnection, DbErr};

use crate::sql::run;

/// How long a format case is kept, in seconds.
pub const FORMAT_CASES_SECONDS: i64 = 90 * 24 * 60 * 60;

/// How long a sanitiser's verdict is kept, in seconds.
pub const SANITISED_SECONDS: i64 = 90 * 24 * 60 * 60;

/// Every bounded table held to its bound at `now`, in Unix seconds: how many rows each gave up, by table.
pub async fn sweep(db: &DatabaseConnection, now: i64) -> Result<Vec<(&'static str, u64)>, DbErr> {
  let mut swept = vec![];

  for (table, column, kept) in [
    ("format_cases", "at", FORMAT_CASES_SECONDS),
    ("sanitised_texts", "judged_at", SANITISED_SECONDS),
  ] {
    let gone = run(
      db,
      &format!(r#"DELETE FROM "{table}" WHERE "{column}" < $1"#),
      vec![(now - kept).into()],
    )
    .await?;

    swept.push((table, gone));
  }

  Ok(swept)
}
