//! The session summariser: a round read for its conversation alone, a record found where its program keeps it,
//! the note the next run is handed, and the hook's whole answer from the session handed in. Korean a room said
//! is written here by its escapes.

use std::path::{Path, PathBuf};

use gate_policy::handover::HANDOVER;
use gate_runs::RecordFolders;
use gate_runs::summary::{
  Closed, Kind, Turn, carried, claude_record, handover, room_of, said_in_round, system, transcript_text,
  turns_from_text,
};
use serde_json::json;

use crate::fakes::{self, mapping, provider, turn_end};
use crate::{ground, wait};

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

#[test]
fn a_record_path_is_its_folder_made_safe_under_the_projects() {
  assert_eq!(
    claude_record(Path::new("/c"), "/w/x/.repo", "s-1"),
    PathBuf::from("/c/projects/-w-x--repo/s-1.jsonl")
  );
}

#[test]
fn a_record_gives_the_conversation_and_nothing_of_its_tools() {
  let raw = [
    json!({ "type": "user", "message": { "role": "user", "content": "asked" } }).to_string(),
    json!({ "type": "assistant", "message": { "role": "assistant", "content": [
      { "type": "thinking", "thinking": "hidden" }, { "type": "text", "text": " answered " }
    ] } })
    .to_string(),
    json!({ "type": "tool_result", "message": { "role": "user", "content": "a tool" } }).to_string(),
    "not json".to_owned(),
  ]
  .join("\n");

  assert_eq!(
    turns_from_text(&raw),
    [
      Turn {
        assistant: false,
        text: "asked".into()
      },
      Turn {
        assistant: true,
        text: "answered".into()
      }
    ]
  );
}

#[test]
fn a_note_carries_the_summary_cut_or_says_nothing_was_recovered() {
  assert!(carried(Kind::Worker, None).contains("could not be recovered"));
  assert!(carried(Kind::Switch, Some("work")).contains("set aside on its own model"));
  assert!(carried(Kind::Chat, Some(" thread ")).ends_with("WHAT YOU WERE IN THE MIDDLE OF:\nthread"));
  assert_eq!(
    carried(Kind::Worker, Some(&"x".repeat(5_000))).lines().last().map(str::len),
    Some(HANDOVER.summary_char_cap)
  );
}

fn closed(kind: Kind, mode: &str) -> Closed {
  Closed {
    kind,
    mode: mode.to_owned(),
    session_id: None,
    cwd: "/w/project".to_owned(),
    account: None,
    transcript: None,
    own_note: None,
    chat_id: Some(-100),
  }
}

#[tokio::test]
async fn the_hook_answers_the_summary_of_the_session_its_record_holds() {
  let (scratch, agency, gateway) = ground().await;
  let folder = std::env::temp_dir().join(format!("gate-runs-summary-{}", std::process::id()));
  let session = closed(Kind::Chat, "claude-code");
  let record = claude_record(&folder, &session.cwd, "a-session");

  std::fs::create_dir_all(record.parent().unwrap()).unwrap();
  std::fs::write(
    &record,
    json!({ "type": "assistant", "message": { "role": "assistant", "content": "we were planning" } })
      .to_string(),
  )
  .unwrap();

  let runs = fakes::runs(
    scratch.db(),
    &agency,
    &gateway,
    RecordFolders {
      claude: vec![std::env::temp_dir().join("a-folder-holding-nothing"), folder.clone()],
      codex: None,
    },
  );

  agency.providers.lock().unwrap().push(provider("claude-code", false));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("claude-code".into(), mapping("claude-code", "a-model", None, None));
  *agency.label.lock().unwrap() = Some("The Agent".into());
  *agency.end.lock().unwrap() = Some(turn_end("answered", Some("We were planning the trip."), None));
  wait(&runs, "session-summary", 30_000).await;

  let note = handover(
    &runs,
    &Closed {
      session_id: Some("a-session".into()),
      ..session.clone()
    },
  )
  .await;
  let turn = agency.turns.lock().unwrap()[0].clone();

  assert!(note.ends_with("WHAT YOU WERE IN THE MIDDLE OF:\nWe were planning the trip."), "{note}");
  assert!(turn.system.starts_with("the recollection rulebook\n\n"));
  assert!(turn.system.contains("The Agent"), "{}", turn.system);
  assert!(!turn.system.contains("{{agent}}"));
  assert_eq!(turn.prompt, format!("{}\nThe Agent: we were planning", HANDOVER.summary_heading));
  assert_eq!(turn.chat, Some(-100));

  // A worker's own note is carried as it stands, and a session with nothing to read says nothing was recovered.
  let own = handover(
    &runs,
    &Closed {
      own_note: Some("my own note".into()),
      ..closed(Kind::Worker, "codex")
    },
  )
  .await;

  assert!(own.ends_with("\nmy own note"));
  assert_eq!(handover(&runs, &closed(Kind::Worker, "codex")).await, carried(Kind::Worker, None));
  assert_eq!(agency.turns.lock().unwrap().len(), 1);

  std::fs::remove_dir_all(&folder).unwrap();
}

#[tokio::test]
async fn a_transcript_handed_in_is_summarised_as_it_stands() {
  let (scratch, agency, gateway) = ground().await;
  let runs = crate::runs_of(&scratch, &agency, &gateway);

  agency.providers.lock().unwrap().push(provider("registry", true));
  agency
    .mappings
    .lock()
    .unwrap()
    .insert("registry".into(), mapping("registry", "a-registration", None, None));
  gateway.answers(vec![fakes::completion("none")]);
  wait(&runs, "session-summary", 30_000).await;

  let note = handover(
    &runs,
    &Closed {
      transcript: Some("the tail as it was kept".into()),
      ..closed(Kind::Switch, "openrouter")
    },
  )
  .await;
  let asked = gateway.asked.lock().unwrap()[0].clone();

  assert_eq!(note, carried(Kind::Switch, None));
  assert_eq!(asked.input, format!("{}\nthe tail as it was kept", HANDOVER.summary_heading));
  assert!(system(&runs, Kind::Switch, "x").await.unwrap().contains("worker"));
}
