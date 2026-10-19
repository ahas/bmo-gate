//! `reference inputs` (docs/reference-selection.md, 「Replaying a stored turn's inputs」): a stored turn in, the Laya
//! input each reference gate would be handed for it today out.
//!
//! A turn here is a run of stored messages the chat agent answered together, read through the receiver, the quiet
//! instructions it was handed as its prompt's quiet-instruction block carries them, and the line it follows on
//! from where the turn names one. Its lines are written the way a turn run writes them, its speakers are its
//! senders but the chat agent, and each gate's input is what the narrowing and that gate's probe make of them
//! against the fragment table as it stands now, a turn of the chat agent's own lines alone asking each gate as the
//! gate declares. A piece of work — a job's item or a search's question — is asked for by its words in place of
//! messages and answered with the knowledge gate's input alone, as its own run asks it. No model is asked and
//! nothing is written.

use std::collections::HashSet;
use std::io::{Read as _, Write};

use gate_reference::Reference;
use gate_reference::pick::{self, Asked as Question, Candidate, Reader, read_bodies};
use gate_reference::road::{self, Gate, Narrowing, Turn};
use gate_stages::laya::Probe as _;
use gate_stages::ordered::Ordered;
use gate_words::reference_benches as words;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::narrowing::Kept;
use super::{message_line, road_of, stored_message};
use crate::{Answered, Fault};

#[derive(clap::Args, Debug)]
pub struct InputsArgs {
  /// Another database's address.
  #[arg(long, allow_hyphen_values = true)]
  db: Option<String>,
  #[arg(short = 'h', long)]
  help: bool,
}

/// A piece of work asked for by its words, in place of messages.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Work {
  Job {
    title: String,
    instruction: String,
    requester: String,
    #[serde(rename = "requesterId")]
    requester_id: Option<i64>,
  },
  Search {
    query: String,
  },
}

impl Work {
  /// The work's lines, as its own run writes them: a job's item as its requester's line, its title over its
  /// request; a search's question as a line of the chat agent's.
  pub fn lines(&self) -> Vec<String> {
    match self {
      Self::Job {
        title,
        instruction,
        requester,
        requester_id,
      } => vec![road::message_line(requester, *requester_id, &format!("{title}\n{instruction}"))],
      Self::Search { query } => vec![road::instruction_line(query)],
    }
  }
}

// One line of standard input: the room, the messages the turn answered or the work asked for, the turn's quiet
// instructions, the line it follows on from, and the pieces whose body is wanted, by gate.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asked {
  chat_id: i64,
  #[serde(default)]
  message_ids: Vec<i64>,
  work: Option<Work>,
  instructions: Option<String>,
  answered: Option<String>,
  #[serde(default)]
  bodies: IndexMap<String, Vec<String>>,
}

/// What one gate would be handed: the narrowing's counts, the Laya request its probe makes, and each candidate kept
/// with its index line, in the order the gate reads them.
#[derive(Serialize)]
struct GateInput {
  gate: String,
  held: i64,
  kept: Kept,
  capped: i64,
  request: Ordered,
  candidates: Vec<CandidateLine>,
}

#[derive(Serialize)]
struct CandidateLine {
  slug: String,
  about: String,
}

/// A piece asked for by gate and slug: its index line and its body, either none where the room's gate offers it no
/// more.
#[derive(Serialize)]
struct Piece {
  gate: String,
  slug: String,
  about: Option<String>,
  body: Option<String>,
}

// One line of the answer, repeating back what it was asked over.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Answer<'a> {
  chat_id: i64,
  message_ids: &'a [i64],
  #[serde(skip_serializing_if = "Option::is_none")]
  work: Option<&'a Ordered>,
  #[serde(skip_serializing_if = "Option::is_none")]
  instructions: Option<&'a str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  missing: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  gates: Option<Vec<GateInput>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pieces: Option<Vec<Piece>>,
}

pub async fn run(args: InputsArgs) -> Answered {
  if args.help {
    return Ok(vec![words::USAGE_INPUTS.to_owned()]);
  }

  let (_, reference) = road_of(args.db.as_deref()).await?;
  let mut input = String::new();

  std::io::stdin()
    .read_to_string(&mut input)
    .map_err(|why| Fault::failed(format!("reference inputs: standard input could not be read: {why}")))?;
  answer(&reference, &input, &mut std::io::stdout().lock()).await?;

  Ok(vec![])
}

fn fault(why: impl std::fmt::Display) -> Fault {
  Fault::failed(format!("reference inputs: {why}"))
}

/// Every turn of the input answered, a line each, in the order asked.
pub async fn answer(reference: &Reference, input: &str, out: &mut dyn Write) -> Result<(), Fault> {
  for line in input.split('\n').filter(|line| !line.trim().is_empty()) {
    let refused = |why: serde_json::Error| fault(format!("a line is no turn: {why}"));
    let asked: Asked = serde_json::from_str(line).map_err(refused)?;
    // The work as it was written, so the caller reads it back key for key.
    let written: Ordered = serde_json::from_str(line).map_err(refused)?;
    let work = written.entries().and_then(|entries| entries.get("work"));
    let answered = match &asked.work {
      Some(asked_work) => Answer {
        chat_id: asked.chat_id,
        message_ids: &[],
        work,
        instructions: None,
        missing: None,
        gates: Some(work_input(reference, asked.chat_id, asked_work).await?.into_iter().collect()),
        pieces: Some(pieces(reference, &asked).await?),
      },
      None => turn_input(reference, &asked).await?,
    };

    writeln!(out, "{}", serde_json::to_string(&answered).unwrap_or_default()).map_err(fault)?;
  }

  Ok(())
}

// What one stored message turn would hand each gate, or the turn marked missing where a message is gone.
async fn turn_input<'a>(reference: &Reference, asked: &'a Asked) -> Result<Answer<'a>, Fault> {
  let mut messages = vec![];

  for &message_id in &asked.message_ids {
    if let Some(message) = stored_message(reference, asked.chat_id, message_id).await? {
      messages.push(message);
    }
  }

  let mut answered = Answer {
    chat_id: asked.chat_id,
    message_ids: &asked.message_ids,
    work: None,
    instructions: asked.instructions.as_deref(),
    missing: None,
    gates: None,
    pieces: None,
  };

  if messages.len() < asked.message_ids.len() {
    answered.missing = Some(true);
    return Ok(answered);
  }

  // The chat agent's own messages stand under the number the receiver says its words stand under in the room.
  let own = if messages.is_empty() {
    None
  } else {
    reference
      .receiver
      .own_number(reference.chat_agent(), asked.chat_id)
      .await
      .map_err(|why| fault(format!("the receiver: {why}")))?
  };
  let by_agent = |sender: Option<i64>| own.is_some() && sender == own;
  let mut speakers: Vec<i64> = vec![];

  for id in messages
    .iter()
    .filter(|message| !by_agent(message.sender))
    .filter_map(|message| message.sender)
  {
    if !speakers.contains(&id) {
      speakers.push(id);
    }
  }

  let mut lines: Vec<String> = messages.iter().map(message_line).collect();

  if let Some(instructions) = asked.instructions.as_deref().filter(|text| !text.trim().is_empty()) {
    lines.push(road::instruction_line(instructions));
  }

  let people_spoke = messages.iter().any(|message| !by_agent(message.sender));
  let turn = Turn {
    chat_id: asked.chat_id,
    message_lines: lines,
    message_id: None,
    speaker_ids: speakers,
    situation: None,
    holds: None,
    round: None,
    people_spoke,
    answered: asked.answered.clone().filter(|_| people_spoke && !asked.message_ids.is_empty()),
    off: vec![],
    lore: true,
    records: false,
  };
  let mut gates = vec![];

  for gate in road::gates_of(reference, asked.chat_id, reference.chat_agent(), true)
    .await
    .map_err(fault)?
  {
    // A turn with no line at all asks no gate, as on the live road.
    if turn.message_lines.is_empty() || !gate.asks(&turn, false) {
      continue;
    }

    let narrowing = road::narrowing(reference, &turn, &gate, &HashSet::new()).await;

    gates.extend(gate_input(&gate, &narrowing, gate.lines(&turn))?);
  }

  answered.gates = Some(gates);
  answered.pieces = Some(pieces(reference, asked).await?);

  Ok(answered)
}

// The knowledge gate's input for a piece of work, as the work's own run asks it; none where the narrowing leaves
// the gate nothing.
async fn work_input(reference: &Reference, chat_id: i64, work: &Work) -> Result<Option<GateInput>, Fault> {
  let lines = work.lines();
  let Some((gate, narrowing)) = road::work_narrowing(reference, reference.chat_agent(), chat_id, &lines)
    .await
    .map_err(fault)?
  else {
    return Ok(None);
  };

  gate_input(&gate, &narrowing, lines)
}

// One gate's input for lines the narrowing left it candidates on; none where it left none, as the gate is then not
// asked.
fn gate_input(gate: &Gate, narrowing: &Narrowing, lines: Vec<String>) -> Result<Option<GateInput>, Fault> {
  let candidates: Vec<Candidate> = pick::candidates(&narrowing.libraries);

  if candidates.is_empty() {
    return Ok(None);
  }

  let request = gate
    .probe
    .question(&Question {
      message_lines: lines,
      candidates: candidates.clone(),
    })
    .map_err(|why| fault(format!("{} could not be asked: {why:?}", gate.stage)))?;
  let narrowed = &narrowing.narrowed;

  Ok(Some(GateInput {
    gate: gate.stage.clone(),
    held: narrowed.held,
    kept: Kept::of(&narrowed.kept),
    capped: narrowed.capped,
    request: request.ordered(),
    candidates: candidates
      .into_iter()
      .map(|candidate| CandidateLine {
        slug: candidate.slug,
        about: candidate.about,
      })
      .collect(),
  }))
}

// Each piece asked for by gate and slug, looked up in everything the room offers that gate rather than only in what
// the narrowing kept: a piece that attached on the turn may be one the narrowing leaves out today. Its body is read
// where the live road reads it.
async fn pieces(reference: &Reference, asked: &Asked) -> Result<Vec<Piece>, Fault> {
  if asked.bodies.is_empty() {
    return Ok(vec![]);
  }

  let gates = road::gates_of(reference, asked.chat_id, reference.chat_agent(), true)
    .await
    .map_err(fault)?;
  let mut pieces = vec![];

  for (stage, slugs) in &asked.bodies {
    let gate = gates.iter().find(|gate| gate.stage == *stage);
    let offered = gate.map(|gate| pick::offered(&gate.libraries)).unwrap_or_default();
    let bodies = match gate {
      Some(gate) => {
        let reader = Reader {
          agent: reference.chat_agent(),
          chat_id: asked.chat_id,
          stage,
        };

        read_bodies(reference, &reader, &gate.libraries, slugs).await
      }
      None => Default::default(),
    };

    for slug in slugs {
      pieces.push(Piece {
        gate: stage.clone(),
        slug: slug.clone(),
        about: offered.iter().find(|offer| offer.slug == *slug).map(|offer| offer.about.clone()),
        body: bodies.get(slug).map(|(_, text)| text.clone()),
      });
    }
  }

  Ok(pieces)
}
