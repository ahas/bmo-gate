//! A judgement keeps the lines its gate's model was asked of its candidates, each beside what it answered.

use sea_orm_migration::prelude::*;

pub const NAME: &str = "m20261026_000001_judgement_lines";

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
      .execute_unprepared(r#"ALTER TABLE "judgements" ADD COLUMN "lines" text"#)
      .await?;

    Ok(())
  }

  async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
    manager
      .get_connection()
      .execute_unprepared(r#"ALTER TABLE "judgements" DROP COLUMN "lines""#)
      .await?;

    Ok(())
  }
}
