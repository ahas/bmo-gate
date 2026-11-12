//! The migrations that make the store's tables. The record of what ran is a table of the store's own, so
//! the store may share a database with another service's tables without either's record standing in the
//! other's way.

mod m20261019_000001_tables;
mod m20261023_000001_translation_failures;
mod m20261024_000001_offer_rules;
mod m20261026_000001_judgement_lines;
mod m20261026_000002_sanitised_texts;
mod m20261029_000001_retired_tables;
mod m20261102_000001_option_wait;
mod m20261112_000001_road_event;

use sea_orm_migration::prelude::*;

/// The table the store's migrations keep the record of what ran in.
pub const MIGRATIONS_TABLE: &str = "gate_migrations";

/// The migration that makes every table.
pub const TABLES: &str = m20261019_000001_tables::NAME;

/// Every table the store's migrations make, beside the record of what ran.
pub const OWN_TABLES: [&str; 7] = [
  "document_translations",
  "gate_options",
  "gate_roads",
  "judgements",
  "reference_offers",
  "reference_verdicts",
  "web_gate_chats",
];

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
  fn migrations() -> Vec<Box<dyn MigrationTrait>> {
    vec![
      Box::new(m20261019_000001_tables::Migration),
      Box::new(m20261023_000001_translation_failures::Migration),
      Box::new(m20261024_000001_offer_rules::Migration),
      Box::new(m20261026_000001_judgement_lines::Migration),
      Box::new(m20261026_000002_sanitised_texts::Migration),
      Box::new(m20261029_000001_retired_tables::Migration),
      Box::new(m20261102_000001_option_wait::Migration),
      Box::new(m20261112_000001_road_event::Migration),
    ]
  }

  fn migration_table_name() -> DynIden {
    Alias::new(MIGRATIONS_TABLE).into_iden()
  }
}
