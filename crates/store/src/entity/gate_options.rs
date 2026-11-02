//! A gate's own options for one agent: its switch.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "gate_options")]
pub struct Model {
  #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
  pub key: String,
  #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
  pub agent: String,
  pub thinking: Option<i64>,
  pub answer_tokens: Option<i64>,
  pub set_at: i64,
  pub enabled: Option<i64>,
  pub rowid: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
