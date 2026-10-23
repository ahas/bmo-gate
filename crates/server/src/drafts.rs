//! The `draft` stage (`docs/gates.md`, 「What a turn records」): each row of a round's draft process the receiver
//! tells is written as a judgement of the round, its verdict the row's place, name and outcome, or the process's
//! end, and its detail the answer's length, whether it changed and how long the turn took. Nothing of what was
//! asked or answered is judged.

use gate_ports::receiver::Drafted;
use gate_runs::records;
use gate_stages::sql;
use gate_store::entity::judgements;
use sea_orm::{DatabaseConnection, DbErr};

/// The stage the rows are written under.
pub const STAGE: &str = "draft";

/// The verdict a row is written with, or none where the row is the round's own turn, which leaves no judgement.
pub fn verdict(drafted: &Drafted) -> Option<String> {
  match drafted.kind.as_str() {
    "question" | "item" | "check" => {
      Some(format!("ROUND {} {}: {}", drafted.number, drafted.question, drafted.outcome))
    }
    "end" => Some(format!("END: {}", drafted.outcome)),
    _ => None,
  }
}

/// The row's detail: the answer's length, whether it changed and the turn's time, then what the receiver said of
/// the row where it said anything.
pub fn detail(drafted: &Drafted) -> String {
  let counted =
    format!("answerChars={} changed={} ms={}", drafted.answer_chars, drafted.changed, drafted.ms);

  match drafted.detail.as_deref().filter(|said| !said.is_empty()) {
    Some(said) => format!("{counted}; {said}"),
    None => counted,
  }
}

/// The row written as a judgement of its round, under the message one of the round's judgements already stands
/// under; none where the row leaves no judgement or the same judgement stands already, as it does when the
/// stream replays a row the gate has read before.
pub async fn write(db: &DatabaseConnection, drafted: &Drafted) -> Result<Option<judgements::Model>, DbErr> {
  let Some(verdict) = verdict(drafted) else {
    return Ok(None);
  };
  let round = || sea_orm::Value::from(drafted.round.clone());
  let standing = sql::one(
    db,
    r#"SELECT "id" FROM "judgements" WHERE "chat_id" = $1 AND "round" = $2 AND "stage" = $3 AND "verdict" = $4
       LIMIT 1"#,
    vec![drafted.chat_id.into(), round(), STAGE.into(), verdict.clone().into()],
  )
  .await?;

  if standing.is_some() {
    return Ok(None);
  }

  let answered = sql::one(
    db,
    r#"SELECT "message_id" FROM "judgements" WHERE "chat_id" = $1 AND "round" = $2 AND "message_id" IS NOT NULL
       ORDER BY "id" DESC LIMIT 1"#,
    vec![drafted.chat_id.into(), round()],
  )
  .await?;
  let message_id = match answered {
    Some(row) => row.try_get::<Option<i64>>("", "message_id")?,
    None => None,
  };
  let detail = detail(drafted);

  Ok(
    records::judgement(
      db,
      &records::Judgement {
        chat_id: drafted.chat_id,
        message_id,
        stage: STAGE,
        verdict: &verdict,
        detail: Some(&detail),
        ms: Some(drafted.ms),
        round: Some(&drafted.round),
      },
    )
    .await,
  )
}
