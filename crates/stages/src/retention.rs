//! What the gate keeps no longer than its bound (`docs/boundary-api.md`, 「Its tables」): the output gate's format
//! cases (`docs/output-gate.md`, 「The case collection」), ninety days, swept over the whole table.

use sea_orm::{DatabaseConnection, DbErr};

use crate::sql::run;

/// How long a format case is kept, in milliseconds.
pub const FORMAT_CASES_MS: i64 = 90 * 24 * 60 * 60 * 1_000;

/// Every bounded table held to its bound at `now`, in epoch milliseconds: how many rows each gave up, by table.
pub async fn sweep(db: &DatabaseConnection, now: i64) -> Result<Vec<(&'static str, u64)>, DbErr> {
  let mut swept = vec![];

  for (table, column, kept) in [("format_cases", "at", FORMAT_CASES_MS)] {
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
