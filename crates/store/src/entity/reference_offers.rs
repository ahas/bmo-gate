//! What one gate was offered on one turn: what the libraries held, what the narrowing kept and by which rule.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "reference_offers")]
pub struct Model {
  #[sea_orm(primary_key)]
  pub id: i64,
  #[sea_orm(column_type = "Text")]
  pub stage: String,
  pub chat_id: i64,
  pub message_id: Option<i64>,
  pub held: i64,
  pub asked: i64,
  pub by_item: i64,
  pub by_keyword: i64,
  pub by_person: i64,
  pub capped: i64,
  #[sea_orm(column_type = "Text")]
  pub slugs: String,
  pub created_at: i64,
  pub rowid: i64,
  #[sea_orm(column_type = "Text")]
  pub round: Option<String>,
  #[sea_orm(column_type = "Text")]
  pub rules: Option<String>,
  pub by_word: i64,
  pub by_recent: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
