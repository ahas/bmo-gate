//! What a gate was offered counts the candidates its content words and its recent hand-outs kept, beside the
//! item, keyword and person rules'.

use sea_orm_migration::prelude::*;

pub const NAME: &str = "m20261024_000001_offer_rules";

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
      .execute_unprepared(
        r#"ALTER TABLE "reference_offers"
             ADD COLUMN "by_word" bigint NOT NULL DEFAULT 0,
             ADD COLUMN "by_recent" bigint NOT NULL DEFAULT 0"#,
      )
      .await?;

    Ok(())
  }

  async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
    manager
      .get_connection()
      .execute_unprepared(
        r#"ALTER TABLE "reference_offers" DROP COLUMN "by_word", DROP COLUMN "by_recent""#,
      )
      .await?;

    Ok(())
  }
}
