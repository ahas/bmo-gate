//! The session summariser: a round read for its conversation alone, the transcript it is handed, and what it is
//! told. Korean a room said is written here by its escapes.

use gate_runs::summary::{Kind, Turn, room_of, said_in_round, system, transcript_text};

use crate::ground;

// A greeting and its answer, as a room and the agent said them.
const HELLO: &str = "\u{c548}\u{b155}";
const YES: &str = "\u{b124}";

#[test]
fn a_round_gives_the_summariser_its_conversation_alone() {
  let prompt =
    format!("Chat id: -100\nheader\nNew messages (2):\nOwner: {HELLO}\nEND OF NEW MESSAGES\ntrailer");
  let turns = [
    Turn {
      assistant: false,
      text: prompt.clone(),
    },
    Turn {
      assistant: true,
      text: YES.to_owned(),
    },
  ];

  assert_eq!(said_in_round(&prompt), format!("Owner: {HELLO}"));
  assert_eq!(
    transcript_text(&turns, "Agent", 1_000),
    format!("Room (room -100): Owner: {HELLO}\n\nAgent (room -100): {YES}")
  );
  assert_eq!(transcript_text(&turns, "Agent", 4), format!("): {YES}"));
}

#[test]
fn a_room_is_read_off_its_chat_id_line_as_a_whole_number() {
  assert_eq!(room_of("x\nChat id: -100 rest").as_deref(), Some("-100"));
  assert_eq!(room_of("Chat id: 42").as_deref(), Some("42"));
  assert_eq!(room_of("Chat id: 42abc"), None);
  assert_eq!(room_of("Chat id: -"), None);
  assert_eq!(room_of(" Chat id: 1"), None);
}

#[tokio::test]
async fn the_summariser_is_told_the_recollection_rulebook_and_its_instructions_for_the_agent() {
  let (scratch, agency, gateway) = ground().await;
  let runs = crate::runs_of(&scratch, &agency, &gateway);
  let chat = system(&runs, Kind::Chat, "The Agent").await.unwrap();
  let worker = system(&runs, Kind::Worker, "The Agent").await.unwrap();

  assert!(chat.starts_with("the recollection rulebook\n\n"), "{chat}");
  assert!(chat.contains("The Agent"), "{chat}");
  assert!(!chat.contains("{{agent}}"));
  assert_ne!(chat, worker);
}
