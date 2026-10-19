//! The session summary, which answers the agency's `session-summariser` hook (`docs/boundary-api.md`, 「For
//! bmo-agency: the session summariser」): what a closed session was in the middle of, read off the record its
//! program wrote rather than out of the session, written by the session-summary gate on its one road, and the
//! note the next run is handed — the summary under the policy's heading, or the word that nothing was
//! recovered. A worker's own note, where it wrote one, is carried as it stands. A summariser that failed, was
//! stopped or gave nothing leaves no summary: nobody waits on it.

use std::path::{Path, PathBuf};

use gate_policy::handover::{HANDOVER, Notes};
use gate_policy::prompts;
use serde::Deserialize;
use serde_json::Value;

use crate::{GateRequest, Runs, fault};

/// The gate the summary is written by.
pub const STAGE: &str = "session-summary";

/// The rulebook every recollector reads before its own instructions.
pub const RECOLLECTION: &str = "recollection";

/// Whose session is summarised: a room's, whose note ends in the quiet word, or a worker's, whose note points at
/// the job its prompt states — closed, or set aside on its own model while the worker turns to another.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
  Chat,
  Worker,
  Switch,
}

impl Kind {
  // The summariser's instructions: a session set aside is summarised as a worker's is.
  fn word(self) -> &'static str {
    match self {
      Self::Chat => "chat",
      Self::Worker | Self::Switch => "worker",
    }
  }

  // The notes the next session is handed under.
  fn notes(self) -> &'static Notes {
    match self {
      Self::Chat => &HANDOVER.chat,
      Self::Worker => &HANDOVER.worker,
      Self::Switch => &HANDOVER.switch,
    }
  }
}

/// One turn of a session's conversation as its record keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Turn {
  pub assistant: bool,
  pub text: String,
}

/// The session the note is asked for, as the agency's hook asks it: whose session it was, the provider it stood
/// on, its id, the folder it worked in, the login it was opened under, the tail a road that keeps no record left
/// of it, the worker's own note, and the room whose session it was.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Closed {
  pub kind: Kind,
  pub mode: String,
  pub session_id: Option<String>,
  pub cwd: String,
  pub account: Option<String>,
  pub transcript: Option<String>,
  pub own_note: Option<String>,
  pub chat_id: Option<i64>,
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

// One entry's words: its text, or its text blocks trimmed and joined a line apart.
fn entry_text(content: Option<&Value>) -> String {
  match content {
    Some(Value::String(text)) => text.trim().to_owned(),
    Some(Value::Array(blocks)) => blocks
      .iter()
      .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
      .filter_map(|block| block.get("text").and_then(Value::as_str))
      .map(str::trim)
      .filter(|text| !text.is_empty())
      .collect::<Vec<_>>()
      .join("\n"),
    _ => String::new(),
  }
}

/// The conversation out of a record written one JSON entry to a line, as Claude Code writes it; a line that does
/// not read is no turn, and neither is a tool's call, its answer or a thought.
pub fn turns_from_text(raw: &str) -> Vec<Turn> {
  raw
    .split('\n')
    .filter(|line| !line.trim().is_empty())
    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    .filter(|entry| matches!(entry.get("type").and_then(Value::as_str), Some("user" | "assistant")))
    .filter_map(|entry| {
      let text = entry_text(entry.pointer("/message/content"));

      (!text.is_empty()).then(|| Turn {
        assistant: entry.pointer("/message/role").and_then(Value::as_str) == Some("assistant"),
        text,
      })
    })
    .collect()
}

/// Where Claude Code keeps one session's record: the folder it worked in with every character that is no letter
/// or digit turned into a dash, under the projects of the configuration it was written under.
pub fn claude_record(config_dir: &Path, cwd: &str, session_id: &str) -> PathBuf {
  let project: String = cwd
    .chars()
    .flat_map(|char| {
      let dashes = if char.is_ascii_alphanumeric() { 0 } else { char.len_utf16() };

      (dashes == 0).then_some(char).into_iter().chain(std::iter::repeat_n('-', dashes))
    })
    .collect();

  config_dir.join("projects").join(project).join(format!("{session_id}.jsonl"))
}

/// A Codex thread's conversation out of its rollout under the sessions folder: its messages from the user and the
/// agent, nothing of its tools or its reasoning.
pub fn codex_turns(sessions: &Path, thread: &str) -> Vec<Turn> {
  if thread.is_empty() || !thread.chars().all(|letter| letter.is_ascii_alphanumeric() || letter == '-') {
    return vec![];
  }

  let suffix = format!("-{thread}.jsonl");
  let mut dirs = vec![sessions.to_path_buf()];
  let mut found = None;

  while let Some(dir) = dirs.pop() {
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
      let path = entry.path();

      if path.is_dir() {
        dirs.push(path);
      } else if found.is_none()
        && path.file_name().is_some_and(|name| name.to_string_lossy().ends_with(&suffix))
      {
        found = Some(path);
      }
    }
  }

  let Some(raw) = found.and_then(|path| std::fs::read_to_string(path).ok()) else {
    return vec![];
  };

  raw
    .split('\n')
    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    .filter(|event| event.get("type").and_then(Value::as_str) == Some("response_item"))
    .filter_map(|event| event.get("payload").cloned())
    .filter(|payload| payload.get("type").and_then(Value::as_str) == Some("message"))
    .filter_map(|payload| {
      let role = payload.get("role").and_then(Value::as_str)?;

      if role != "user" && role != "assistant" {
        return None;
      }

      let text = payload
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
          parts
            .iter()
            .filter(|part| {
              matches!(part.get("type").and_then(Value::as_str), Some("input_text" | "output_text"))
            })
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
        })
        .unwrap_or_default();

      (!text.is_empty()).then(|| Turn {
        assistant: role == "assistant",
        text,
      })
    })
    .collect()
}

/// The provider whose program writes a Claude Code record, and the one whose program writes a Codex rollout.
const CLAUDE_CODE: &str = "claude-code";
const CODEX: &str = "codex";

// The tail of the closed session's conversation: the one its road left where it keeps no record, or the record
// its program wrote, read from the first record folder that holds it; nothing on a road that keeps none.
fn tail(runs: &Runs, closed: &Closed, agent: &str) -> String {
  if let Some(held) = &closed.transcript {
    return held.clone();
  }

  let Some(id) = closed.session_id.as_deref() else { return String::new() };
  let cap = HANDOVER.transcript_tail_chars;
  let turns = match closed.mode.as_str() {
    CLAUDE_CODE => runs
      .records
      .claude
      .iter()
      .map(|config| claude_record(config, &closed.cwd, id))
      .find_map(|record| std::fs::read_to_string(record).ok())
      .map(|raw| turns_from_text(&raw))
      .unwrap_or_default(),
    CODEX => runs
      .records
      .codex
      .as_deref()
      .map(|sessions| codex_turns(sessions, id))
      .unwrap_or_default(),
    _ => vec![],
  };

  transcript_text(&turns, agent, cap)
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

/// What the closed session was in the middle of, as the summariser writes it; none where its record holds
/// nothing, or the summariser failed, was stopped or said there was nothing.
pub async fn summary(runs: &Runs, closed: &Closed) -> Option<String> {
  let agent = agent_name(runs).await;
  let transcript = tail(runs, closed, &agent);

  if transcript.trim().is_empty() {
    return None;
  }

  let system = system(runs, closed.kind, &agent).await.ok()?;
  let mut request = GateRequest::new(system, format!("{}\n{transcript}", HANDOVER.summary_heading));

  request.chat_id = closed.chat_id;

  let text = Box::pin(runs.run(STAGE, &request)).await.ok()??;
  let text = text.trim();

  (!text.is_empty() && !text.eq_ignore_ascii_case("none")).then(|| text.to_owned())
}

/// The note the next run is handed: the summary under its heading, cut to the cap, or the word that nothing was
/// recovered.
pub fn carried(kind: Kind, summary: Option<&str>) -> String {
  let notes = kind.notes();

  match summary {
    None => notes.lost.join("\n"),
    Some(summary) => {
      let all = units(summary.trim());
      let cut = String::from_utf16_lossy(&all[..all.len().min(HANDOVER.summary_char_cap)]);

      notes.carried.iter().cloned().chain(std::iter::once(cut)).collect::<Vec<_>>().join("\n")
    }
  }
}

/// The note a closed session leaves for the next run: the worker's own where it wrote one, the summariser's
/// otherwise.
pub async fn handover(runs: &Runs, closed: &Closed) -> String {
  let summary = match &closed.own_note {
    Some(note) => Some(note.clone()),
    None => summary(runs, closed).await,
  };

  carried(closed.kind, summary.as_deref())
}
