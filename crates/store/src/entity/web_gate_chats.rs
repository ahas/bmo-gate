//! One trial of a gate: the prompt, who asked, the answer and how long it took.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "web_gate_chats")]
pub struct Model {
  #[sea_orm(primary_key)]
  pub id: i64,
  #[sea_orm(column_type = "Text")]
  pub stage: String,
  #[sea_orm(column_type = "Text")]
  pub user_name: String,
  #[sea_orm(column_type = "Text")]
  pub prompt: String,
  #[sea_orm(column_type = "Text")]
  pub answer: Option<String>,
  pub ms: i64,
  pub created_at: i64,
  pub rowid: i64,
  pub user_id: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
