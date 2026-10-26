//! One decision written into a room's log: a gate's verdict, a round's skip, a re-ask, an answer sent.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "judgements")]
pub struct Model {
  #[sea_orm(primary_key)]
  pub id: i64,
  pub chat_id: i64,
  pub message_id: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub stage: String,
  #[sea_orm(column_type = "Text")]
  pub verdict: String,
  #[sea_orm(column_type = "Text")]
  pub detail: Option<String>,
  pub created_at: i64,
  pub ms: Option<i64>,
  #[sea_orm(column_type = "Text")]
  pub round: Option<String>,
  pub rowid: i64,
  /// The lines a gate's model was asked of its candidates, each with what it answered, as JSON; none where it
  /// was asked none.
  #[sea_orm(column_type = "Text")]
  pub lines: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
