//! The migrations make every table of the store in an empty database, and nothing else, and record what ran
//! in the store's own record; an install from before 1.0.0 at its last release is taken as it stands, and one
//! short of it is refused (docs/boundary-api.md, 「Its tables」).

use gate_store::migration::{BEFORE, MIGRATIONS_TABLE, Migrator, OWN_TABLES, TABLES};
use sea_orm::ConnectionTrait;
use sea_orm_migration::MigratorTrait;

use crate::support::scratch::Scratch;

const TABLES_NOW: &str = "SELECT table_name::text FROM information_schema.tables \
   WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name";

#[tokio::test]
async fn the_migrations_make_every_table_of_the_store_and_nothing_else() {
  let scratch = Scratch::blank().await;

  gate_store::migration::up(scratch.db()).await.unwrap();

  let mut expected: Vec<String> = OWN_TABLES.iter().map(|name| (*name).to_owned()).collect();
  expected.push(MIGRATIONS_TABLE.to_owned());
  expected.sort();
  assert_eq!(scratch.texts(TABLES_NOW, vec![]).await, expected);
}

#[tokio::test]
async fn what_ran_is_recorded_in_the_stores_own_record_and_nothing_is_left_pending() {
  let scratch = Scratch::new().await;

  let ran = scratch
    .count(
      &format!(r#"SELECT COUNT(*) FROM "{MIGRATIONS_TABLE}" WHERE "version" = $1"#),
      vec![TABLES.into()],
    )
    .await;

  assert_eq!(ran, 1);
  assert!(Migrator::get_pending_migrations(scratch.db()).await.unwrap().is_empty());
}

#[tokio::test]
async fn every_index_the_readers_lean_on_stands() {
  let scratch = Scratch::new().await;
  let indexes = scratch
    .texts(
      "SELECT indexname::text FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname",
      vec![],
    )
    .await;

  for index in [
    "gate_roads_chat",
    "gate_roads_event",
    "gate_roads_round",
    "gate_roads_stage",
    "judgements_chat",
    "judgements_message",
    "reference_offers_round",
    "reference_offers_stage",
    "reference_verdicts_chat",
    "reference_verdicts_one",
    "reference_verdicts_stage",
    "web_gate_chats_stage",
  ] {
    assert!(indexes.iter().any(|stands| stands == index), "{index} does not stand: {indexes:?}");
  }
}

#[tokio::test]
async fn a_gate_option_names_its_agent_and_none_is_filled_in() {
  let scratch = Scratch::new().await;

  let nameless = scratch
    .run(r#"INSERT INTO "gate_options" ("key", "set_at") VALUES ('a-gate', 1)"#, vec![])
    .await;
  assert!(nameless.is_err(), "a gate option with no agent was kept");

  scratch
    .run(
      r#"INSERT INTO "gate_options" ("key", "agent", "set_at") VALUES ('a-gate', 'chat-agent', 1)"#,
      vec![],
    )
    .await
    .unwrap();
  let kept = scratch
    .count(r#"SELECT COUNT(*) FROM "gate_options" WHERE "agent" = 'chat-agent'"#, vec![])
    .await;
  assert_eq!(kept, 1);
}

#[tokio::test]
async fn a_reference_verdict_stands_once_for_its_gate_turn_and_piece() {
  let scratch = Scratch::new().await;
  let insert = r#"INSERT INTO "reference_verdicts" ("stage", "chat_id", "message_id", "slug", "created_at")
    VALUES ('library-knowledge', 7, $1, 'quiet-hours', 1)"#;

  scratch.run(insert, vec![Option::<i64>::None.into()]).await.unwrap();
  assert!(
    scratch.run(insert, vec![Option::<i64>::None.into()]).await.is_err(),
    "a turn with no message took two"
  );

  scratch.run(insert, vec![Some(41_i64).into()]).await.unwrap();
  assert!(scratch.run(insert, vec![Some(41_i64).into()]).await.is_err(), "one message took two");
}

#[tokio::test]
async fn a_rows_rowid_follows_its_id() {
  let scratch = Scratch::new().await;

  scratch
    .run(
      r#"INSERT INTO "judgements" ("id", "chat_id", "stage", "verdict", "created_at") VALUES (90, 7, 'a-stage', 'PASS', 1)"#,
      vec![],
    )
    .await
    .unwrap();
  let rowid = scratch.count(r#"SELECT "rowid" FROM "judgements" WHERE "id" = 90"#, vec![]).await;

  assert_eq!(rowid, 90);
}

const BASELINE: &str = include_str!("../../crates/store/src/migration/baseline.sql");

// Every column and index of the store but the record's, in one line.
const SHAPE: &str = "SELECT (SELECT string_agg(table_name || '.' || column_name || ' ' || data_type || ' ' || \
   is_nullable || ' ' || COALESCE(column_default, ''), ', ' ORDER BY table_name, ordinal_position) \
   FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> 'gate_migrations') \
   || ' / ' || (SELECT string_agg(indexdef, ', ' ORDER BY indexname) FROM pg_indexes \
   WHERE schemaname = current_schema() AND tablename <> 'gate_migrations')";

const RECORDED: &str = r#"SELECT "version" FROM "gate_migrations" ORDER BY "version""#;

// A blank database holding the baseline's schema and a row, recorded as an install from before 1.0.0 that ran
// the first `through` migrations of its last release.
async fn installed(through: usize) -> Scratch {
  let scratch = Scratch::blank().await;
  scratch.db().execute_unprepared(BASELINE).await.unwrap();
  scratch
    .run(
      r#"CREATE TABLE "gate_migrations" ("version" varchar PRIMARY KEY, "applied_at" bigint NOT NULL)"#,
      vec![],
    )
    .await
    .unwrap();
  for version in &BEFORE[..through] {
    scratch
      .run(
        r#"INSERT INTO "gate_migrations" ("version", "applied_at") VALUES ($1, 1)"#,
        vec![(*version).into()],
      )
      .await
      .unwrap();
  }
  scratch
    .run(
      r#"INSERT INTO "gate_options" ("key", "agent", "set_at") VALUES ('a-gate', 'chat-agent', 1)"#,
      vec![],
    )
    .await
    .unwrap();
  scratch
}

#[tokio::test]
async fn an_install_at_the_last_release_before_the_baseline_only_has_its_record_rewritten() {
  let scratch = installed(BEFORE.len()).await;
  let before = scratch.texts(SHAPE, vec![]).await;

  gate_store::migration::up(scratch.db()).await.unwrap();
  assert_eq!(scratch.texts(RECORDED, vec![]).await, [TABLES]);
  assert_eq!(scratch.texts(SHAPE, vec![]).await, before);
  assert_eq!(scratch.count(r#"SELECT COUNT(*) FROM "gate_options""#, vec![]).await, 1);

  // A second start finds the baseline recorded and changes nothing.
  gate_store::migration::up(scratch.db()).await.unwrap();
  assert_eq!(scratch.texts(RECORDED, vec![]).await, [TABLES]);
  assert_eq!(scratch.texts(SHAPE, vec![]).await, before);
}

#[tokio::test]
async fn an_install_short_of_the_last_release_before_the_baseline_is_refused() {
  let scratch = installed(3).await;

  let refused = gate_store::migration::up(scratch.db()).await.unwrap_err().to_string();
  assert!(refused.contains(BEFORE[2]), "{refused}");
  assert_eq!(scratch.texts(RECORDED, vec![]).await.len(), 3);
}

#[tokio::test]
async fn a_blank_database_gets_the_baseline_as_its_laid_down_whole() {
  let migrated = Scratch::blank().await;
  gate_store::migration::up(migrated.db()).await.unwrap();
  let laid = Scratch::blank().await;
  laid.db().execute_unprepared(BASELINE).await.unwrap();

  assert_eq!(migrated.texts(SHAPE, vec![]).await, laid.texts(SHAPE, vec![]).await);
  assert_eq!(migrated.texts(RECORDED, vec![]).await, [TABLES]);
}
