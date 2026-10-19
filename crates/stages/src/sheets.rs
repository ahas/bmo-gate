//! A person-book sheet's judgement (`docs/boundary-api.md`, `POST /sheets/judge`; the brain's `docs/people-book.md`,
//! 「The standing layer — standing sheets」): one person's sheet of one part written by the summariser, one tool-less
//! gate run on the `people-standing` key or on the registration the agent's recollectors go out on, from the pieces
//! the brain hands in, and held at this end to the ceiling it names, the part's own sections and the days its pieces
//! name. The brain cuts a person's pieces into groups and folds their sheets; each call is one group's.

use std::sync::LazyLock;

use gate_markup::js;
use gate_policy::prompts;
use gate_runs::{GateError, GateRequest};
use regex::Regex;
use serde::Deserialize;

use crate::Stages;

/// The summariser's key.
pub const STAGE: &str = "people-standing";

/// The rulebooks the summariser reads before its own instructions.
pub const RULEBOOKS: [&str; 2] = ["document-writing", "plain-writing"];

/// The two parts of a person's book: the common part every room the person speaks in reads, and one room's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Part {
  Common,
  Room,
}

impl Part {
  /// The fixed sections this part's sheet is written under, in order.
  pub fn sections(self) -> &'static [&'static str] {
    match self {
      Self::Common => &[
        "Personality",
        "Values",
        "Speech",
        "Habits",
        "Working requests",
        "Dislikes and cautions",
        "Humor",
      ],
      Self::Room => &["Address", "Relations", "Ongoing and promises"],
    }
  }

  fn other(self) -> Self {
    match self {
      Self::Common => Self::Room,
      Self::Room => Self::Common,
    }
  }
}

/// One piece a sheet is written from.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Piece {
  pub path: String,
  pub text: String,
}

/// A sheet to judge, as the brain asks it: whose book it is, the part, the room for a room part, the person, the
/// pieces, the most characters the sheet may hold, and the registration its recollectors go out on where they name
/// one.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetAsk {
  pub agent: String,
  pub part: Part,
  pub chat_id: Option<i64>,
  pub person: i64,
  pub pieces: Vec<Piece>,
  pub ceiling: usize,
  pub registration: Option<String>,
}

static DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d{4}-\d{2}-\d{2}").expect("a day"));

/// Whether every day a sheet names is a day its pieces name: the sheet attaches on every turn, and a day it made up
/// would be read as a record.
pub fn sheet_dates_known(sheet: &str, pieces: &[Piece]) -> bool {
  let given: std::collections::HashSet<&str> = pieces
    .iter()
    .flat_map(|piece| DAY.find_iter(&piece.text).map(|day| day.as_str()))
    .collect();

  DAY.find_iter(sheet).all(|day| given.contains(day.as_str()))
}

/// Why a sheet the summariser wrote for one part cannot stand, or none when it can: nothing written, over the
/// ceiling, a section of the other part, or a day none of its pieces names.
pub fn sheet_problem(part: Part, ceiling: usize, sheet: &str, pieces: &[Piece]) -> Option<String> {
  if sheet.is_empty() {
    return Some("nothing".to_owned());
  }

  if js::units(sheet) > ceiling {
    return Some(format!("{} characters, over the {ceiling} ceiling", js::units(sheet)));
  }

  let foreign: Vec<&str> = part
    .other()
    .sections()
    .iter()
    .filter(|section| sheet.split('\n').any(|line| js::trim(line) == format!("## {section}")))
    .copied()
    .collect();

  if !foreign.is_empty() {
    return Some(format!("a section of the other part ({})", foreign.join(", ")));
  }

  if !sheet_dates_known(sheet, pieces) {
    return Some("a day none of its pieces names".to_owned());
  }

  None
}

/// What one summarising call asks: the agent, the part and nothing more of where the pieces came from — a common
/// sheet names no room — the person, and the pieces.
pub fn standing_prompt(ask: &SheetAsk) -> String {
  let part = match ask.part {
    Part::Common => "Part: common".to_owned(),
    Part::Room => format!("Part: room-only\nChat id: {}", ask.chat_id.unwrap_or_default()),
  };
  let mut lines = vec![
    format!("Agent: {}", ask.agent),
    part,
    format!("Person: user id {}", ask.person),
    String::new(),
    "PIECES:".to_owned(),
  ];

  lines.extend(ask.pieces.iter().map(|piece| format!("[{}]\n{}", piece.path, piece.text)));
  lines.join("\n")
}

/// The summariser's instructions: the rulebooks it reads, then its own.
pub async fn system(stages: &Stages) -> Result<String, GateError> {
  let own = prompts::instructions(STAGE)
    .ok_or_else(|| GateError::Fault(format!("{STAGE}: its instructions are not among the prompts")))?;
  let rulebooks = stages
    .runs
    .agency
    .rulebooks(&RULEBOOKS)
    .await
    .map_err(|why| GateError::Fault(why.to_string()))?;
  let mut parts = vec![];

  for name in RULEBOOKS {
    let rulebook = rulebooks
      .iter()
      .find(|rulebook| rulebook.name == name)
      .ok_or_else(|| GateError::Fault(format!("the agency holds no {name} rulebook")))?;

    parts.push(rulebook.text.trim().to_owned());
  }

  parts.push(own.to_owned());

  Ok(parts.join("\n\n"))
}

/// The sheet one call wrote, held to the ask's terms, or none where the summariser gave nothing that can stand.
pub async fn judge(stages: &Stages, ask: &SheetAsk) -> Option<String> {
  if ask.pieces.is_empty() {
    return None;
  }

  let system = match system(stages).await {
    Ok(system) => system,
    Err(why) => {
      eprintln!("{STAGE}: its instructions could not be had: {why}");
      return None;
    }
  };
  let mut request = GateRequest::new(system, standing_prompt(ask));

  request.chat_id = ask.chat_id;
  request.agent = Some(ask.agent.clone());
  request.alongside = true;
  request.registration = ask.registration.clone();

  let answer = match stages.runs.run(STAGE, &request).await {
    Ok(answer) => answer,
    Err(why) => {
      eprintln!("{STAGE}: the summariser of {} did not answer: {why}", ask.person);
      None
    }
  };
  let sheet = answer.map(|answer| js::trim(&answer).to_owned()).unwrap_or_default();

  if let Some(problem) = sheet_problem(ask.part, ask.ceiling, &sheet, &ask.pieces) {
    eprintln!("{STAGE}: a sheet of {} got {problem} from one call", ask.person);
    return None;
  }

  Some(sheet)
}
