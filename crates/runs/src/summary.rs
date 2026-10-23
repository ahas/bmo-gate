//! The session summary: what a session about to be replaced was in the middle of, written by the session-summary
//! gate on its one road from the tail of its conversation. No unit asks it at a turn (`docs/gates.md`), so it runs
//! under the evaluation set alone, which hands it the conversation as its items keep it.

use crate::{Runs, fault};
use gate_policy::handover::HANDOVER;
use gate_policy::prompts;

/// The gate the summary is written by.
pub const STAGE: &str = "session-summary";

/// The rulebook every recollector reads before its own instructions.
pub const RECOLLECTION: &str = "recollection";

/// Whose session is summarised: a room's, or a job worker's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
  Chat,
  Worker,
}

impl Kind {
  // The summariser's instructions for this kind of session.
  fn word(self) -> &'static str {
    match self {
      Self::Chat => "chat",
      Self::Worker => "worker",
    }
  }
}

/// One turn of a session's conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Turn {
  pub assistant: bool,
  pub text: String,
}

// The UTF-16 units of a text.
fn units(text: &str) -> Vec<u16> {
  text.encode_utf16().collect()
}

/// What a room actually said in one round, out of the prompt the receiver built around it: the lines of its
/// conversation blocks alone, the scaffolding around them left out.
pub fn said_in_round(prompt: &str) -> String {
  let mut kept = vec![];
  let mut closing: Option<&str> = None;

  for line in prompt.split('\n') {
    match closing {
      None => {
        closing = HANDOVER
          .conversation
          .iter()
          .find(|block| line.starts_with(&block.open))
          .map(|block| block.close.as_str());
      }
      Some(close) if line.trim_end() == close => closing = None,
      Some(_) => kept.push(line),
    }
  }

  kept.join("\n").trim().to_owned()
}

/// The room a round's prompt names on its `Chat id:` line, a signed whole number ending at a word's end.
pub fn room_of(prompt: &str) -> Option<String> {
  prompt.lines().find_map(|line| {
    let rest = line.strip_prefix("Chat id: ")?;
    let sign = usize::from(rest.starts_with('-'));
    let digits = rest[sign..].bytes().take_while(u8::is_ascii_digit).count();
    let end = sign + digits;
    let ends_a_word = !rest[end..].chars().next().is_some_and(|next| next.is_alphanumeric() || next == '_');

    (digits > 0 && ends_a_word).then(|| rest[..end].to_owned())
  })
}

/// The end of a session's conversation as the summariser reads it: the agent's answers under its own name, a
/// round's conversation alone under the room's, at most so many UTF-16 units from its end.
pub fn transcript_text(turns: &[Turn], agent: &str, cap: usize) -> String {
  let mut said = vec![];
  let mut room: Option<String> = None;

  for turn in turns {
    if !turn.assistant
      && let Some(found) = room_of(&turn.text)
    {
      room = Some(found);
    }

    let text = if turn.assistant { turn.text.clone() } else { said_in_round(&turn.text) };

    if text.is_empty() {
      continue;
    }

    let speaker = if turn.assistant { agent } else { HANDOVER.room_speaker.as_str() };
    let room = room.as_ref().map_or_else(String::new, |room| format!(" (room {room})"));

    said.push(format!("{speaker}{room}: {text}"));
  }

  let joined = said.join("\n\n");
  let all = units(&joined);

  if all.len() <= cap {
    joined
  } else {
    String::from_utf16_lossy(&all[all.len() - cap..])
  }
}

/// The name the chat agent goes by in a transcript and in the summariser's instructions: its label where its
/// registration gives one, its name otherwise.
pub async fn agent_name(runs: &Runs) -> String {
  let agents = runs.agency.agents().await.unwrap_or_default();

  agents
    .into_iter()
    .find(|agent| agent.name == runs.chat_agent)
    .and_then(|agent| agent.label)
    .unwrap_or_else(|| runs.chat_agent.clone())
}

/// What the summariser is told: the recollectors' rulebook and its own instructions for this kind of session.
pub async fn system(runs: &Runs, kind: Kind, agent: &str) -> Result<String, crate::GateError> {
  let path = format!("{STAGE}/{}.md", kind.word());
  let instructions =
    prompts::read(&path).ok_or_else(|| fault(format!("{path} is not among the prompts")))?;
  let rulebooks = runs.agency.rulebooks(&[RECOLLECTION]).await.map_err(fault)?;
  let rulebook = rulebooks
    .into_iter()
    .find(|rulebook| rulebook.name == RECOLLECTION)
    .ok_or_else(|| fault(format!("the agency holds no {RECOLLECTION} rulebook")))?;

  Ok(format!(
    "{}\n\n{}",
    rulebook.text.trim(),
    prompts::render(instructions, &[("agent", agent)])
  ))
}
