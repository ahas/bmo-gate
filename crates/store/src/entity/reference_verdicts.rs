//! One candidate's verdict on one turn of a reference gate: the LLM's, and whether it attached.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "reference_verdicts")]
pub struct Model {
  #[sea_orm(primary_key)]
  pub id: i64,
  #[sea_orm(column_type = "Text")]
  pub stage: String,
  pub chat_id: i64,
  pub message_id: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub slug: String,
  pub llm: Option<i64>,
  pub attached: Option<i64>,
  pub created_at: i64,
  pub rowid: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
