//! A road the agency's event stream told is kept with the number of its event, so the stream is read on from the
//! newest number kept (`docs/boundary-api.md`, 「The roads walked」).

use sea_orm_migration::prelude::*;

pub const NAME: &str = "m20261112_000001_road_event";

pub struct Migration;

impl MigrationName for Migration {
  fn name(&self) -> &str {
    NAME
  }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
  async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
    let db = manager.get_connection();

    db.execute_unprepared(r#"ALTER TABLE "gate_roads" ADD COLUMN IF NOT EXISTS "event" bigint"#)
      .await?;
    db.execute_unprepared(r#"CREATE INDEX IF NOT EXISTS "gate_roads_event" ON "gate_roads" (event)"#)
      .await?;

    Ok(())
  }

  async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
    let db = manager.get_connection();

    db.execute_unprepared(r#"DROP INDEX IF EXISTS "gate_roads_event""#).await?;
    db.execute_unprepared(r#"ALTER TABLE "gate_roads" DROP COLUMN IF EXISTS "event""#)
      .await?;

    Ok(())
  }
}
