//! One road a gate run, or a conversational turn, walked: its provider, model, outcome, time and tokens.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "gate_roads")]
pub struct Model {
  #[sea_orm(primary_key)]
  pub id: i64,
  #[sea_orm(column_type = "Text")]
  pub stage: String,
  pub chat_id: Option<i64>,
  pub message_id: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub provider: String,
  #[sea_orm(column_type = "Text")]
  pub model: String,
  #[sea_orm(column_type = "Text")]
  pub outcome: String,
  pub ms: i64,
  pub created_at: i64,
  pub input_tokens: Option<i64>,
  pub output_tokens: Option<i64>,
  pub cache_read_tokens: Option<i64>,
  pub cache_write_tokens: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub round: Option<String>,
  #[sea_orm(column_type = "Text")]
  pub run: Option<String>,
  pub rowid: i64,
  pub context_ratio: Option<f64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
