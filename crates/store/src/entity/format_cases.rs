//! One structure-check failure of the output gate: the reason, the original and the markup that failed.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "format_cases")]
pub struct Model {
  #[sea_orm(primary_key)]
  pub id: i64,
  pub at: i64,
  pub chat_id: Option<i64>,
  pub message_id: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub stage: String,
  pub attempt: i64,
  #[sea_orm(column_type = "Text")]
  pub reason: String,
  #[sea_orm(column_type = "Text")]
  pub text: String,
  #[sea_orm(column_type = "Text")]
  pub markup: String,
  #[sea_orm(column_type = "Text")]
  pub closing: Option<String>,
  pub rowid: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
