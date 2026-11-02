//! A gate's options hold no wait: no run is ended for the time it takes, so the column a wait was kept in is
//! dropped.

use sea_orm_migration::prelude::*;

pub const NAME: &str = "m20261102_000001_option_wait";

pub struct Migration;

impl MigrationName for Migration {
  fn name(&self) -> &str {
    NAME
  }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
  async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
    manager
      .get_connection()
      .execute_unprepared(r#"ALTER TABLE "gate_options" DROP COLUMN IF EXISTS "timeout_ms""#)
      .await?;

    Ok(())
  }

  async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
    manager
      .get_connection()
      .execute_unprepared(r#"ALTER TABLE "gate_options" ADD COLUMN IF NOT EXISTS "timeout_ms" bigint"#)
      .await?;

    Ok(())
  }
}
