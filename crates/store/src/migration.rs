//! The migrations that make the store's tables. The record of what ran is a table of the store's own, so
//! the store may share a database with another service's tables without either's record standing in the
//! other's way.

mod m20261019_000001_tables;
mod m20261023_000001_translation_failures;

use sea_orm_migration::prelude::*;

/// The table the store's migrations keep the record of what ran in.
pub const MIGRATIONS_TABLE: &str = "gate_migrations";

/// The migration that makes every table.
pub const TABLES: &str = m20261019_000001_tables::NAME;

/// Every table the store's migrations make, beside the record of what ran.
pub const OWN_TABLES: [&str; 11] = [
  "document_translations",
  "format_cases",
  "gate_options",
  "gate_roads",
  "judgements",
  "laya_health",
  "laya_verdicts",
  "reference_offers",
  "reference_verdicts",
  "sanitised_texts",
  "web_gate_chats",
];

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
  fn migrations() -> Vec<Box<dyn MigrationTrait>> {
    vec![
      Box::new(m20261019_000001_tables::Migration),
      Box::new(m20261023_000001_translation_failures::Migration),
    ]
  }

  fn migration_table_name() -> DynIden {
    Alias::new(MIGRATIONS_TABLE).into_iden()
  }
}
