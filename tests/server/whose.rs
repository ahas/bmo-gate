//! Whose reference it is (`docs/reference-selection.md`, 「Whose reference it is」): each supervisor of an account
//! reads its own brain alone, the deployment's own supervisor reads as it does with no account, an agent keeping no
//! brain has no index, and an index asked for nobody is refused.

use gate_ports::agency::Supervisor;
use gate_ports::brain::BrainKey;
use reqwest::StatusCode;
use serde_json::{Value, json};

use super::{Ground, ROOM, ground};
use crate::reference::fakes::fragment;

// Two supervisors of two accounts and the deployment's own, each brain holding one note of its own.
fn furnished(ground: &Ground) {
  for (name, account) in [("u7", Some(7)), ("u8", Some(8)), ("the-chat-agent", None)] {
    ground.agency.supervisors.lock().unwrap().insert(
      name.to_owned(),
      Supervisor {
        owner_account: account,
      },
    );
  }

  ground.brain.own.lock().unwrap().extend([
    (
      BrainKey::owned("u7", 7),
      vec![fragment("library-knowledge", "u7-notes", "the first account's notes", None, None)],
    ),
    (
      BrainKey::owned("u8", 8),
      vec![fragment("library-knowledge", "u8-notes", "the second account's notes", None, None)],
    ),
    (
      BrainKey::unowned("the-chat-agent"),
      vec![fragment("library-knowledge", "deploy-notes", "the deployment's notes", None, None)],
    ),
  ]);
}

// Every slug an index answers, across its groups.
fn slugs(index: &Value) -> Vec<String> {
  index["groups"]
    .as_array()
    .unwrap()
    .iter()
    .flat_map(|group| group["entries"].as_array().unwrap().iter())
    .map(|entry| entry["slug"].as_str().unwrap().to_owned())
    .collect()
}

#[tokio::test]
async fn each_supervisor_reads_its_own_accounts_brain_alone() {
  let ground = ground("whose-own", |_| None).await;

  furnished(&ground);

  for (agent, own) in [("u7", "u7-notes"), ("u8", "u8-notes"), ("the-chat-agent", "deploy-notes")] {
    let (status, index) = ground.get(&format!("/reference/index?room={ROOM}&agent={agent}")).await;

    assert_eq!(status, StatusCode::OK, "{index}");
    assert_eq!(slugs(&index), [own], "{agent}");

    let (_, found) = ground.get(&format!("/reference/search?q=notes&room={ROOM}&agent={agent}")).await;
    let found: Vec<&str> = found["entries"]
      .as_array()
      .unwrap()
      .iter()
      .map(|entry| entry["slug"].as_str().unwrap())
      .collect();

    assert_eq!(found, [own], "{agent}");
  }

  let (status, _) = ground
    .get(&format!("/reference/pieces/u7-notes?room={ROOM}&group=knowledge&agent=u8"))
    .await;

  assert_eq!(status, StatusCode::NOT_FOUND, "one account's piece is not another's");

  let read = ground.brain.read.lock().unwrap().clone();

  assert!(read.contains(&BrainKey::owned("u7", 7)) && read.contains(&BrainKey::owned("u8", 8)));
  assert!(
    read.iter().all(|key| [
      BrainKey::owned("u7", 7),
      BrainKey::owned("u8", 8),
      BrainKey::unowned("the-chat-agent")
    ]
    .contains(key)),
    "{read:?}"
  );
}

#[tokio::test]
async fn an_agent_keeping_no_brain_has_no_index_and_nobody_named_is_refused() {
  let ground = ground("whose-none", |_| None).await;

  furnished(&ground);

  let (status, index) = ground.get(&format!("/reference/index?room={ROOM}&agent=a-stranger")).await;

  assert_eq!(status, StatusCode::OK, "{index}");
  assert_eq!(index["groups"], json!([]), "no memory index at all");

  let (_, found) = ground.get(&format!("/reference/search?q=notes&room={ROOM}&agent=a-stranger")).await;

  assert_eq!(found["entries"], json!([]));

  for asked in [
    format!("/reference/index?room={ROOM}"),
    format!("/reference/index?room={ROOM}&agent=%20"),
    format!("/reference/search?q=notes&room={ROOM}"),
    format!("/reference/pieces/deploy-notes?room={ROOM}&group=knowledge"),
  ] {
    assert_eq!(ground.get(&asked).await.0, StatusCode::BAD_REQUEST, "{asked}");
  }
  assert!(
    !ground.brain.read.lock().unwrap().contains(&BrainKey::unowned("the-chat-agent")),
    "nothing is read from the chat agent's brain in its place"
  );
}

#[tokio::test]
async fn a_turn_is_handed_only_what_its_own_supervisors_brain_holds() {
  let ground = ground("whose-turn", |_| None).await;

  furnished(&ground);

  let (status, body) = ground
    .post(
      "/reference/selected",
      json!({
        "roomId": ROOM,
        "lines": ["Someone (id 5): hello"],
        "speakerIds": [5],
        "situation": { "agentName": "u8", "roomKind": "group", "events": [], "nowAt": 1 },
        "peopleSpoke": true,
        "records": true,
      }),
    )
    .await;

  assert_eq!(status, StatusCode::OK, "{body}");

  let read = ground.brain.read.lock().unwrap().clone();

  assert!(!read.is_empty() && read.iter().all(|key| *key == BrainKey::owned("u8", 8)), "{read:?}");
}
