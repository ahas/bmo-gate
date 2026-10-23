//! A part of a document's translation kept as failed says why: the sentence naming what its last answer lost.

use sea_orm_migration::prelude::*;

pub const NAME: &str = "m20261023_000001_translation_failures";

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
      .execute_unprepared(r#"ALTER TABLE "document_translations" ADD COLUMN "failure" text"#)
      .await?;

    Ok(())
  }

  async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
    manager
      .get_connection()
      .execute_unprepared(r#"ALTER TABLE "document_translations" DROP COLUMN "failure""#)
      .await?;

    Ok(())
  }
}
