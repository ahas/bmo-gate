//! The gate's store (`docs/boundary-api.md`, 「What the gate owns」): its eleven tables in a database of its
//! own, the migrations that make them, the entities its code reads and writes them through, and the
//! connection every reader opens.

pub mod entity;
pub mod import;
pub mod migration;

use std::str::FromStr;

use sea_orm::{DatabaseConnection, SqlxPostgresConnector};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

/// A connection to the store at the address the settings name, a pool of at most `connections`.
pub async fn connect(address: &str, connections: u32) -> Result<DatabaseConnection, sqlx::Error> {
  let options = PgConnectOptions::from_str(address)?;

  connect_with(options, connections).await
}

/// A connection to the store the options name, a pool of at most `connections`.
pub async fn connect_with(
  options: PgConnectOptions,
  connections: u32,
) -> Result<DatabaseConnection, sqlx::Error> {
  let pool = PgPoolOptions::new().max_connections(connections).connect_with(options).await?;

  Ok(SqlxPostgresConnector::from_sqlx_postgres_pool(pool))
}
