//! A store of a test's own as a database of its own: the store migrated once per test binary into a template
//! database, and each test handed a copy of it, which the server makes in a fraction of the time a migration
//! takes. A copy is dropped when its test is done, and the template and copies a binary left behind are
//! dropped by the next binary to make a template.
//!
//! Each group of tests that needs a store includes this file as a module of its own and uses what it needs
//! of it, so what one group leaves unused is no fault.

#![allow(dead_code)]

use std::str::FromStr;
use std::sync::atomic::{AtomicU32, Ordering};

use gate_store::migration::Migrator;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, Value};
use sea_orm_migration::MigratorTrait;
use sqlx::postgres::{PgConnectOptions, PgConnection};
use sqlx::{Connection as _, Executor};

// What a template's and a copy's names begin with, ahead of the process that made them.
const TEMPLATE: &str = "gate_rs_tmpl_";
const COPY: &str = "gate_rs_copy_";

static COPIES: AtomicU32 = AtomicU32::new(0);
static MADE: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

/// The suite's PostgreSQL server, as the run names it, and the machine's own socket where nothing does.
pub fn test_options() -> PgConnectOptions {
  let address = std::env::var("BMO_TEST_POSTGRES")
    .unwrap_or_else(|_| "postgres:///bmo_test?host=/var/run/postgresql".into());

  PgConnectOptions::from_str(&address).expect("the test server's address reads")
}

/// Whether a process is alive, read off the kernel's own listing.
fn alive(pid: &str) -> bool {
  std::path::Path::new("/proc").join(pid).exists()
}

async fn server() -> PgConnection {
  PgConnection::connect_with(&test_options().database("postgres")).await.unwrap()
}

async fn create(name: &str, template: &str) {
  let mut admin = server().await;

  admin
    .execute(
      format!(
        "CREATE DATABASE \"{name}\" TEMPLATE \"{template}\" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
      )
      .as_str(),
    )
    .await
    .unwrap();
  admin.close().await.unwrap();
}

// The template this binary's copies are made from, migrated the first time a test asks. The databases a
// binary that is gone left behind are dropped first.
async fn template() -> String {
  MADE
    .get_or_init(|| async {
      let mut admin = server().await;
      let left: Vec<String> = sqlx::query_scalar(
        "SELECT datname::text FROM pg_database WHERE datname LIKE $1 OR datname LIKE $2",
      )
      .bind(format!("{}%", TEMPLATE.replace('_', "\\_")))
      .bind(format!("{}%", COPY.replace('_', "\\_")))
      .fetch_all(&mut admin)
      .await
      .unwrap();

      for old in left {
        let pid = old
          .trim_start_matches(TEMPLATE)
          .trim_start_matches(COPY)
          .split('_')
          .next()
          .unwrap_or_default();

        if !alive(pid) {
          let _ = admin.execute(format!("DROP DATABASE IF EXISTS \"{old}\" WITH (FORCE)").as_str()).await;
        }
      }
      admin.close().await.unwrap();

      let name = format!("{TEMPLATE}{}", std::process::id());

      create(&name, "template0").await;

      let db = connect(&name).await;

      Migrator::up(&db, None).await.unwrap();
      db.close().await.unwrap();

      name
    })
    .await
    .clone()
}

/// A connection to a database of the test server.
pub async fn connect(database: &str) -> DatabaseConnection {
  gate_store::connect_with(test_options().database(database), 4).await.unwrap()
}

fn next_name() -> String {
  format!("{COPY}{}_{}", std::process::id(), COPIES.fetch_add(1, Ordering::SeqCst))
}

/// A copy dropped, its connections ended with it. It goes on a thread of its own, since a guard dropped inside
/// the runtime may not block on it.
fn drop_database(database: String) {
  let _ = std::thread::spawn(move || {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

    runtime.block_on(async move {
      let mut admin = server().await;

      let _ = admin
        .execute(format!("DROP DATABASE IF EXISTS \"{database}\" WITH (FORCE)").as_str())
        .await;
      let _ = admin.close().await;
    });
  })
  .join();
}

/// A database of the test's own, dropped when the guard goes.
pub struct Scratch {
  database: String,
  db: DatabaseConnection,
}

impl Scratch {
  /// A migrated, empty store.
  pub async fn new() -> Scratch {
    let database = next_name();

    create(&database, &template().await).await;

    let db = connect(&database).await;

    Scratch { database, db }
  }

  /// A database no migration has run in.
  pub async fn blank() -> Scratch {
    let database = next_name();

    create(&database, "template0").await;

    let db = connect(&database).await;

    Scratch { database, db }
  }

  pub fn db(&self) -> &DatabaseConnection {
    &self.db
  }

  /// A statement run as written, answering whether it ran.
  pub async fn run(&self, sql: &str, values: Vec<Value>) -> Result<(), sea_orm::DbErr> {
    self
      .db
      .execute(Statement::from_sql_and_values(DbBackend::Postgres, sql, values))
      .await
      .map(|_| ())
  }

  /// A count a statement answers.
  pub async fn count(&self, sql: &str, values: Vec<Value>) -> i64 {
    let row = self
      .db
      .query_one(Statement::from_sql_and_values(DbBackend::Postgres, sql, values))
      .await
      .unwrap()
      .expect("a count answers a row");

    row.try_get_by_index::<i64>(0).unwrap()
  }

  /// The text column a statement answers in every row, in order.
  pub async fn texts(&self, sql: &str, values: Vec<Value>) -> Vec<String> {
    let rows = self
      .db
      .query_all(Statement::from_sql_and_values(DbBackend::Postgres, sql, values))
      .await
      .unwrap();

    rows.iter().map(|row| row.try_get_by_index::<String>(0).unwrap()).collect()
  }
}

impl Drop for Scratch {
  fn drop(&mut self) {
    drop_database(std::mem::take(&mut self.database));
  }
}
