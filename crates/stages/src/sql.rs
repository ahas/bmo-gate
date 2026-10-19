//! The statements the gates write their own tables with, as written, on Postgres.

use sea_orm::{ConnectionTrait, DbBackend, DbErr, QueryResult, Statement, Value};

fn statement(sql: &str, values: Vec<Value>) -> Statement {
  Statement::from_sql_and_values(DbBackend::Postgres, sql, values)
}

/// The first row a query answers, where it answers one.
pub async fn one(
  db: &impl ConnectionTrait,
  sql: &str,
  values: Vec<Value>,
) -> Result<Option<QueryResult>, DbErr> {
  db.query_one(statement(sql, values)).await
}

/// Every row a query answers.
pub async fn all(
  db: &impl ConnectionTrait,
  sql: &str,
  values: Vec<Value>,
) -> Result<Vec<QueryResult>, DbErr> {
  db.query_all(statement(sql, values)).await
}

/// A statement run, answering how many rows it touched.
pub async fn run(db: &impl ConnectionTrait, sql: &str, values: Vec<Value>) -> Result<u64, DbErr> {
  Ok(db.execute(statement(sql, values)).await?.rows_affected())
}
