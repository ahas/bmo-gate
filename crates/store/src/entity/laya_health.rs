//! The Laya server's last health check, the one row the table holds.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "laya_health")]
pub struct Model {
  #[sea_orm(primary_key)]
  pub id: i64,
  #[sea_orm(column_type = "Text")]
  pub state: String,
  #[sea_orm(column_type = "Text")]
  pub model: Option<String>,
  #[sea_orm(column_type = "Text")]
  pub device: Option<String>,
  pub vram_bytes: Option<i64>,
  pub load_ms: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub versions: Option<String>,
  pub check_ms: Option<i64>,
  pub checked_at: Option<i64>,
  pub healthy_at: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub address: Option<String>,
  pub rowid: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
