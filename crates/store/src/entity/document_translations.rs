//! One part of one version of a document, translated into one language.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "document_translations")]
pub struct Model {
  #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
  pub document: String,
  #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
  pub version: String,
  #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
  pub target: String,
  #[sea_orm(primary_key, auto_increment = false)]
  pub part: i64,
  pub parts: i64,
  #[sea_orm(column_type = "Text")]
  pub text: Option<String>,
  pub failed: i64,
  pub translated_at: i64,
  pub rowid: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
