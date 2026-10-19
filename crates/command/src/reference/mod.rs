//! The reference road's benches (docs/reference-selection.md, 「What it picks and what it costs, measured」 and
//! 「Replaying a stored turn's inputs」): what the road offers, narrows, picks and attaches, measured over stored
//! turns on the road a turn walks now. Each calls the road's own functions rather than a copy of them — but for
//! the index files' road the roads bench sets beside it, which it writes out on purpose — and reads another unit's
//! records only through that unit's routes.

pub mod compare;
pub mod inputs;
pub mod narrowing;
pub mod replay;
pub mod roads;
pub mod waste;

use std::sync::Arc;

use clap::Subcommand;
use gate_policy::reference::REFERENCE;
use gate_ports::receiver::Message;
use gate_reference::Reference;
use gate_reference::road;
use gate_server::settings::Settings;

use crate::{Answered, Fault};

#[derive(Subcommand, Debug)]
pub enum ReferenceNoun {
  /// Stored runs of the one reference classifier put to the three gates that pick now, the two sides compared.
  #[command(disable_help_flag = true)]
  Compare(compare::CompareArgs),
  /// Stored turns on standard input, each gate's Laya input as it would be asked now on standard output; no model
  /// is asked and nothing is written.
  #[command(disable_help_flag = true)]
  Inputs(inputs::InputsArgs),
  /// How many candidates the narrowing leaves each gate on the turns the chat agent answered, room by room.
  #[command(disable_help_flag = true)]
  Narrowing(narrowing::NarrowingArgs),
  /// Judged turns put through the road again, the gates really asked, what attaches now set beside what attached
  /// then.
  #[command(disable_help_flag = true)]
  Replay(replay::ReplayArgs),
  /// What the fragment rows offer each gate, room by room, beside what the shipped index files themselves name.
  #[command(disable_help_flag = true)]
  Roads(roads::RoadsArgs),
  /// Every piece the gates attached: how often, how often the answer used it, and the tokens carried for nothing;
  /// reads only.
  #[command(disable_help_flag = true)]
  Waste(waste::WasteArgs),
}

/// One of the benches, on the settings this run reads.
pub async fn run(noun: ReferenceNoun) -> Answered {
  match noun {
    ReferenceNoun::Compare(args) => compare::run(args).await,
    ReferenceNoun::Inputs(args) => inputs::run(args).await,
    ReferenceNoun::Narrowing(args) => narrowing::run(args).await,
    ReferenceNoun::Replay(args) => replay::run(args).await,
    ReferenceNoun::Roads(args) => roads::run(args).await,
    ReferenceNoun::Waste(args) => waste::run(args).await,
  }
}

/// The settings and the reference road a bench reads: the gates over the gate's database, or the one `db` names,
/// and the brain and the receiver the settings name.
pub async fn road_of(db: Option<&str>) -> Result<(Settings, Arc<Reference>), Fault> {
  let settings = crate::settings()?;
  let db = crate::database(&settings, db).await?;
  let stages = gate_server::stages(&settings, db).map_err(Fault::failed)?;
  let reference = gate_server::reference(&settings, stages).map_err(Fault::failed)?;

  Ok((settings, reference))
}

/// A command line a bench does not read: its usage, ending as a usage refused ends.
pub fn misread(usage: &str) -> Fault {
  Fault::Words(usage.to_owned())
}

/// A count a flag gives: a whole number written in digits alone, `fallback` where the flag is not given.
pub fn count(given: Option<&str>, fallback: usize, usage: &str) -> Result<usize, Fault> {
  match given {
    None => Ok(fallback),
    Some(given) if !given.is_empty() && given.bytes().all(|byte| byte.is_ascii_digit()) => {
      given.parse().map_err(|_| misread(usage))
    }
    Some(_) => Err(misread(usage)),
  }
}

/// A number as JavaScript writes it into JSON: a whole one without a fraction.
pub fn js_number(value: f64) -> serde_json::Number {
  if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
    serde_json::Number::from(value as i64)
  } else {
    serde_json::Number::from_f64(value).unwrap_or_else(|| serde_json::Number::from(0))
  }
}

/// The gates whose attachments are counted: the three reference gates and the person book's search.
pub fn counted_gates() -> Vec<String> {
  REFERENCE
    .gates
    .iter()
    .map(|gate| gate.stage.clone())
    .chain([REFERENCE.people.stage.clone()])
    .collect()
}

/// A stored message as one of a turn's lines, as a turn run writes it.
pub fn message_line(message: &Message) -> String {
  road::message_line(message.sender_name.as_deref().unwrap_or_default(), message.sender, &message.text)
}

/// One stored message of a room read through the receiver, none where it keeps no such message.
pub async fn stored_message(
  reference: &Reference,
  chat_id: i64,
  message_id: i64,
) -> Result<Option<Message>, Fault> {
  reference
    .receiver
    .message(chat_id, message_id)
    .await
    .map_err(|why| Fault::failed(format!("the receiver: {why}")))
}

/// The gate's database the benches read, under the road.
pub fn db(reference: &Reference) -> &sea_orm::DatabaseConnection {
  &reference.stages.runs.db
}
