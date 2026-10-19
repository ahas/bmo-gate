//! A text the sanitiser judged, kept under its hash, with the words as they were handed on.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "sanitised_texts")]
pub struct Model {
  #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
  pub hash: String,
  #[sea_orm(column_type = "Text")]
  pub text: String,
  pub changed: i64,
  #[sea_orm(column_type = "Text")]
  pub at: String,
  pub judged_at: i64,
  pub rowid: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
