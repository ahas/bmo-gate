//! Each entity names its table's columns as the migration makes them, in their order, and a row written
//! through an entity reads back as it was written.

use gate_store::entity::{
  document_translations, gate_options, gate_roads, judgements, reference_offers, reference_verdicts,
  web_gate_chats,
};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait, IdenStatic, Iterable};

use crate::scratch::Scratch;

/// The columns an entity names, in the order its model declares them.
fn entity_columns<E: EntityTrait>() -> (String, Vec<String>) {
  let table = E::default().table_name().to_owned();
  let columns = E::Column::iter().map(|column| column.as_str().to_owned()).collect();

  (table, columns)
}

async fn table_columns(scratch: &Scratch, table: &str) -> Vec<String> {
  scratch
    .texts(
      "SELECT column_name::text FROM information_schema.columns \
       WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
      vec![table.into()],
    )
    .await
}

#[tokio::test]
async fn every_entity_names_its_tables_columns_in_their_order() {
  let scratch = Scratch::new().await;
  let entities = [
    entity_columns::<document_translations::Entity>(),
    entity_columns::<gate_options::Entity>(),
    entity_columns::<gate_roads::Entity>(),
    entity_columns::<judgements::Entity>(),
    entity_columns::<reference_offers::Entity>(),
    entity_columns::<reference_verdicts::Entity>(),
    entity_columns::<web_gate_chats::Entity>(),
  ];

  let mut named: Vec<&str> = entities.iter().map(|(table, _)| table.as_str()).collect();
  named.sort();
  assert_eq!(named, gate_store::migration::OWN_TABLES);

  for (table, columns) in &entities {
    assert_eq!(&table_columns(&scratch, table).await, columns, "the columns of {table}");
  }
}

#[tokio::test]
async fn a_judgement_written_through_its_entity_reads_back_with_its_id_and_rowid() {
  let scratch = Scratch::new().await;
  let written = judgements::ActiveModel {
    chat_id: Set(-1007),
    message_id: Set(None),
    stage: Set("a-stage".into()),
    verdict: Set("OPEN".into()),
    detail: Set(Some("the default, the road gave none".into())),
    created_at: Set(1_760_000_000),
    ms: Set(Some(42)),
    round: Set(Some("round-1".into())),
    ..Default::default()
  }
  .insert(scratch.db())
  .await
  .unwrap();

  let read = judgements::Entity::find_by_id(written.id).one(scratch.db()).await.unwrap().unwrap();
  assert_eq!(read, written);
  assert_eq!(read.rowid, read.id);
  assert_eq!(read.chat_id, -1007);
}

#[tokio::test]
async fn a_row_of_every_other_table_is_written_and_read_through_its_entity() {
  let scratch = Scratch::new().await;
  let db = scratch.db();

  let option = gate_options::ActiveModel {
    key: Set("a-gate".into()),
    agent: Set("chat-agent".into()),
    timeout_ms: Set(Some(30_000)),
    set_at: Set(1),
    ..Default::default()
  }
  .insert(db)
  .await
  .unwrap();
  assert_eq!(
    gate_options::Entity::find_by_id(("a-gate".to_owned(), "chat-agent".to_owned()))
      .one(db)
      .await
      .unwrap(),
    Some(option)
  );

  let road = gate_roads::ActiveModel {
    stage: Set("a-stage".into()),
    chat_id: Set(Some(7)),
    provider: Set("registered".into()),
    model: Set("a-registration".into()),
    outcome: Set("answered".into()),
    ms: Set(812),
    created_at: Set(2),
    input_tokens: Set(Some(1_200)),
    context_ratio: Set(Some(0.25)),
    ..Default::default()
  }
  .insert(db)
  .await
  .unwrap();
  assert_eq!(gate_roads::Entity::find_by_id(road.id).one(db).await.unwrap(), Some(road));

  let offer = reference_offers::ActiveModel {
    stage: Set("library-knowledge".into()),
    chat_id: Set(7),
    held: Set(12),
    asked: Set(3),
    by_item: Set(1),
    by_keyword: Set(2),
    by_person: Set(0),
    capped: Set(0),
    slugs: Set("[\"a\",\"b\",\"c\"]".into()),
    created_at: Set(5),
    round: Set(Some("round-1".into())),
    ..Default::default()
  }
  .insert(db)
  .await
  .unwrap();
  assert_eq!(reference_offers::Entity::find_by_id(offer.id).one(db).await.unwrap(), Some(offer));

  let verdict = reference_verdicts::ActiveModel {
    stage: Set("library-knowledge".into()),
    chat_id: Set(7),
    slug: Set("a".into()),
    llm: Set(Some(1)),
    attached: Set(Some(1)),
    created_at: Set(6),
    ..Default::default()
  }
  .insert(db)
  .await
  .unwrap();
  assert_eq!(reference_verdicts::Entity::find_by_id(verdict.id).one(db).await.unwrap(), Some(verdict));

  let part = document_translations::ActiveModel {
    document: Set("docs/gates.md".into()),
    version: Set("v1".into()),
    target: Set("en".into()),
    part: Set(0),
    parts: Set(2),
    text: Set(Some("Gates".into())),
    translated_at: Set(8),
    ..Default::default()
  }
  .insert(db)
  .await
  .unwrap();
  assert_eq!(part.failed, 0, "a part is not failed unless written so");
  assert_eq!(
    document_translations::Entity::find_by_id((
      "docs/gates.md".to_owned(),
      "v1".to_owned(),
      "en".to_owned(),
      0
    ))
    .one(db)
    .await
    .unwrap(),
    Some(part)
  );

  let trial = web_gate_chats::ActiveModel {
    stage: Set("translate".into()),
    user_name: Set("a user".into()),
    prompt: Set("which heading answers this".into()),
    answer: Set(None),
    ms: Set(350),
    created_at: Set(10),
    ..Default::default()
  }
  .insert(db)
  .await
  .unwrap();
  assert_eq!(web_gate_chats::Entity::find_by_id(trial.id).one(db).await.unwrap(), Some(trial));
}
