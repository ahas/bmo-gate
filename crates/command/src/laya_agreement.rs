//! `gate laya-agreement` (docs/laya.md, 「Agreement」): how often Laya agrees with each gate's LLM, over everything
//! recorded — the table the owner reads before choosing a gate's τ and moving it off shadow — from the gate's
//! database or the one `--db` names, which it only reads.

use clap::Args;
use gate_stages::laya_agreement::{
  agreement, agreement_lines, read_pairs, read_question_tallies, settled_each,
};
use gate_words::laya_agreement as words;
use sea_orm::DatabaseConnection;

use crate::ceiling::{Said, cap_items};
use crate::{Answered, Fault};

/// The noun's arguments: one gate, another database's address, and the numbers as they stand.
#[derive(Args, Debug, Default)]
pub struct LayaAgreementArgs {
  /// One gate alone.
  #[arg(long, allow_hyphen_values = true)]
  pub stage: Option<String>,
  /// Another database's address.
  #[arg(long)]
  pub db: Option<String>,
  /// Each gate's figures as JSON.
  #[arg(long)]
  pub json: bool,
  /// The whole usage.
  #[arg(short = 'h', long)]
  pub help: bool,
}

// How the rest of an answer cut at the ceiling is asked for.
const NEXT_PAGE: &str = "Ask one gate at a time with --stage.";

/// What the noun prints, and the line saying what the ceiling cut, which stands beside JSON rather than in it so
/// what is printed still parses.
pub async fn read(
  db: &DatabaseConnection,
  stage: Option<&str>,
  json: bool,
) -> Result<(Vec<String>, Option<String>), Fault> {
  let database = |why: sea_orm::DbErr| Fault::failed(format!("the gate's database: {why}"));
  let pairs = read_pairs(db, stage).await.map_err(database)?;
  let tallies = read_question_tallies(db, &settled_each(), stage).await.map_err(database)?;
  let agreements = agreement(&pairs, &tallies);

  if json {
    let shown = |kept: &[_]| serde_json::to_string_pretty(kept).unwrap_or_default();
    let capped = cap_items(&agreements, shown, Said::new("gates", NEXT_PAGE));

    return Ok((vec![shown(capped.kept)], capped.note));
  }

  let capped =
    cap_items(&agreements, |kept| agreement_lines(kept).join("\n"), Said::new("gates", NEXT_PAGE));
  let mut lines = agreement_lines(capped.kept);

  lines.extend(capped.note);

  Ok((lines, None))
}

/// One run of `bmo gate laya-agreement`.
pub async fn laya_agreement(args: LayaAgreementArgs) -> Answered {
  if args.help {
    return Ok(vec![words::USAGE.to_owned()]);
  }

  let settings = crate::settings()?;
  let db = crate::database(&settings, args.db.as_deref()).await?;
  let (lines, note) = read(&db, args.stage.as_deref(), args.json).await?;

  if let Some(note) = note {
    eprintln!("{note}");
  }

  Ok(lines)
}
