//! What passes from a closed session to the one that replaces it: how much of the old conversation the
//! summariser reads, what it is asked, how long its summary may be, and the note the next run is handed.

use serde::Deserialize;

/// A block of a round's prompt that is the conversation, by the line it opens on and the line it closes on.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
  pub open: String,
  pub close: String,
}

/// The note a session is handed: the one carrying a summary, which ends on the summary's heading, and the one
/// saying nothing was recovered.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notes {
  pub carried: Vec<String>,
  pub lost: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Handover {
  pub transcript_tail_chars: usize,
  pub summary_char_cap: usize,
  pub summary_heading: String,
  pub room_speaker: String,
  pub conversation: Vec<Block>,
  pub chat: Notes,
  pub worker: Notes,
  pub switch: Notes,
}

crate::part!(pub HANDOVER: Handover = "handover.toml");
