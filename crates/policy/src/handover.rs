//! The session summariser's reading: how much of a session's conversation it reads, what it is asked, and how
//! long its summary may be.

use serde::Deserialize;

/// A block of a round's prompt that is the conversation, by the line it opens on and the line it closes on.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
  pub open: String,
  pub close: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Handover {
  pub transcript_tail_chars: usize,
  pub summary_char_cap: usize,
  pub summary_heading: String,
  pub room_speaker: String,
  pub conversation: Vec<Block>,
}

crate::part!(pub HANDOVER: Handover = "handover.toml");
