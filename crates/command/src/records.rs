//! `bmo-gate records <table>` (`docs/boundary-api.md`, 「Records」): every row of one of the gate's own tables,
//! one JSON object a line, which is how the training tooling reads the gate's records into its snapshot. It only
//! reads, and it is no noun.

use clap::Args;
use gate_store::migration::OWN_TABLES;
use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};

use crate::{Answered, Fault};

/// The command's arguments: the table, and another database's address.
#[derive(Args, Debug, Default)]
pub struct RecordsArgs {
  /// One of the gate's own tables.
  pub table: String,
  /// Another database's address.
  #[arg(long)]
  pub db: Option<String>,
}

/// Every row of `table` as one JSON object a line, in the order the rows were written.
pub async fn read(db: &DatabaseConnection, table: &str) -> Result<Vec<String>, Fault> {
  if !OWN_TABLES.contains(&table) {
    return Err(Fault::Words(format!(
      "{table} is not one of the gate's own tables: {}",
      OWN_TABLES.join(", ")
    )));
  }

  // The name is one of the store's own, so it is written into the statement as it stands.
  let asked = format!(r#"SELECT row_to_json(t)::text AS "row" FROM "{table}" t ORDER BY t.rowid"#);
  let database = |why: sea_orm::DbErr| Fault::failed(format!("the gate's database: {why}"));
  let rows = db
    .query_all(Statement::from_string(db.get_database_backend(), asked))
    .await
    .map_err(database)?;

  rows.iter().map(|row| row.try_get::<String>("", "row").map_err(database)).collect()
}

/// One run of `bmo-gate records`.
pub async fn records(args: RecordsArgs) -> Answered {
  let settings = crate::settings()?;
  let db = crate::database(&settings, args.db.as_deref()).await?;

  read(&db, &args.table).await
}
