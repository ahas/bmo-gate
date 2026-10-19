//! `gate format-cases` (docs/output-gate.md, 「The case collection」): the output gate's format cases newest first,
//! each message and candidate cut to what a person needs to recognise it, or one case whole. It only reads.

use clap::Args;
use gate_markup::text::count_text;
use gate_policy::fill_marks;
use gate_store::entity::format_cases;
use gate_words::casebook as words;
use sea_orm::{DatabaseConnection, EntityTrait, PaginatorTrait, QueryOrder, QuerySelect};

use crate::{Answered, Fault};

/// How many cases a page shows where `--limit` names none.
pub const PAGE: i64 = 20;

/// How much of a message or a candidate a page shows of each.
pub const SHOWN_LENGTH: usize = 1_500;

/// The noun's arguments: how many cases, or the one case shown whole.
#[derive(Args, Debug, Default)]
pub struct FormatCasesArgs {
  #[arg(long, allow_negative_numbers = true)]
  pub limit: Option<i64>,
  /// One case, whole.
  #[arg(long)]
  pub show: Option<i64>,
  /// The whole usage.
  #[arg(short = 'h', long)]
  pub help: bool,
}

fn clipped(text: &str, length: usize) -> String {
  if text.chars().count() > length {
    format!("{}\u{2026}", text.chars().take(length).collect::<String>())
  } else {
    text.to_owned()
  }
}

// A moment in Unix seconds as an instant, to the millisecond.
fn instant(seconds: i64) -> String {
  chrono::DateTime::from_timestamp(seconds, 0)
    .map(|at| at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
    .unwrap_or_else(|| seconds.to_string())
}

/// One case as a person reads it, whole where it is the one being read.
pub fn render(case: &format_cases::Model, full: bool) -> String {
  let show = |text: &str| if full { text.to_owned() } else { clipped(text, SHOWN_LENGTH) };
  let room = match case.chat_id {
    Some(chat) => fill_marks(words::ROOM, &[("chat", &chat.to_string())]),
    None => words::NO_ROOM.to_owned(),
  };
  let message = match case.message_id {
    Some(message) => fill_marks(words::MESSAGE, &[("message", &message.to_string())]),
    None => words::NO_MESSAGE.to_owned(),
  };
  let which = if case.attempt == 0 {
    words::CODE_MADE.to_owned()
  } else {
    fill_marks(words::ATTEMPT, &[("attempt", &case.attempt.to_string())])
  };
  let mut lines = vec![
    format!(
      "#{} {} \u{b7} {room} \u{b7} {message} \u{b7} {} \u{b7} {which}",
      case.id,
      instant(case.at),
      case.stage
    ),
    fill_marks(words::REASON, &[("reason", &case.reason)]),
    words::TEXT.to_owned(),
    show(&case.text),
    words::MARKUP.to_owned(),
    show(&case.markup),
  ];

  if let Some(closing) = case.closing.as_deref().filter(|closing| !closing.is_empty()) {
    lines.push(closing.to_owned());
  }

  lines.join("\n")
}

/// The newest cases, up to `limit`, or the one case `show` names, whole.
pub async fn read(db: &DatabaseConnection, limit: i64, show: Option<i64>) -> Answered {
  let database = |why: sea_orm::DbErr| Fault::failed(format!("the gate's database: {why}"));

  if let Some(id) = show {
    return match format_cases::Entity::find_by_id(id).one(db).await.map_err(database)? {
      Some(case) => Ok(vec![render(&case, true)]),
      None => Err(Fault::failed(fill_marks(words::NO_CASE, &[("id", &id.to_string())]))),
    };
  }

  if limit <= 0 {
    return Err(Fault::Words(words::LIMIT.to_owned()));
  }

  let cases = format_cases::Entity::find()
    .order_by_desc(format_cases::Column::At)
    .order_by_desc(format_cases::Column::Id)
    .limit(limit as u64)
    .all(db)
    .await
    .map_err(database)?;

  if cases.is_empty() {
    return Ok(vec![words::NONE.to_owned()]);
  }

  let total = format_cases::Entity::find().count(db).await.map_err(database)?;
  let mut lines = vec![fill_marks(
    words::HEAD,
    &[("shown", &count_text(cases.len())), ("total", &count_text(total as usize))],
  )];

  for case in &cases {
    lines.push(String::new());
    lines.push(render(case, false));
  }

  Ok(lines)
}

/// One run of `bmo gate format-cases`.
pub async fn format_cases(args: FormatCasesArgs) -> Answered {
  if args.help {
    return Ok(vec![words::USAGE.to_owned()]);
  }

  let settings = crate::settings()?;
  let db = crate::database(&settings, None).await?;

  read(&db, args.limit.unwrap_or(PAGE), args.show).await
}
