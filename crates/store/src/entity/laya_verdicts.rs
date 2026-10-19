//! One question pair of a probed gate: what Laya and the LLM each answered, and whose verdict the gate used.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "laya_verdicts")]
pub struct Model {
  #[sea_orm(primary_key)]
  pub id: i64,
  #[sea_orm(column_type = "Text")]
  pub stage: String,
  pub chat_id: Option<i64>,
  pub message_id: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub subject: Option<String>,
  #[sea_orm(column_type = "Text")]
  pub input_hash: String,
  #[sea_orm(column_type = "Text")]
  pub input: String,
  #[sea_orm(column_type = "Text")]
  pub laya: Option<String>,
  pub confidence: Option<f64>,
  #[sea_orm(column_type = "Text")]
  pub llm_verdict: Option<String>,
  #[sea_orm(column_type = "Text")]
  pub llm_answers: Option<String>,
  #[sea_orm(column_type = "Text")]
  pub laya_verdict: Option<String>,
  pub laya_safe: Option<i64>,
  pub llm_safe: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub mode: String,
  #[sea_orm(column_type = "Text")]
  pub used: String,
  pub ms: Option<f64>,
  #[sea_orm(column_type = "Text")]
  pub failure: Option<String>,
  pub created_at: i64,
  pub rowid: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
