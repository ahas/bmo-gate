//! What an organisation hands its members (`docs/reference-selection.md`, 「What an organisation hands its
//! members」): the org sheet a turn carries, held to its ceiling, and the index's `organisation` group, read for the
//! owner of the supervisor alone and for the room's audience.

use gate_policy::reference::REFERENCE;
use gate_ports::accounts::{OrgUnit, Placement};
use gate_ports::agency::Supervisor;
use gate_ports::audience::Audience;
use gate_ports::brain::{OrgMemory, OrgTopic};
use gate_reference::index::{Unanswered, entries, piece};
use gate_reference::organisation::SHEET_PATH;
use gate_reference::road::{Turn, handed};
use gate_reference::{Entry, Source};

use super::{Ground, ground};

const OWNER: i64 = 31;
const COMPANY: i64 = 1;
const TEAM: i64 = 3;
const POST: i64 = 4;

fn unit(id: i64, name: &str) -> OrgUnit {
  OrgUnit {
    id,
    name: name.into(),
  }
}

fn org_memory(id: i64, text: &str, importance: i64, topics: &[&str]) -> OrgMemory {
  OrgMemory {
    id,
    text: text.into(),
    importance,
    locked: false,
    internal_only: false,
    recall_condition: None,
    topics: topics.iter().map(|topic| (*topic).to_owned()).collect(),
    changed_at: 0,
  }
}

fn topic(topic: &str, brain: i64, locked: bool, memories: Vec<OrgMemory>) -> OrgTopic {
  OrgTopic {
    topic: topic.into(),
    brain,
    locked,
    memories,
  }
}

// The owner's supervisor, its owner placed in a team under the company with a post in another team, each unit keeping
// an org brain numbered ten times its own: the company's word on the industry, its locked rule on photographs, the
// team's working hours standing in place of the company's, and a memory of no topic in the team.
fn furnish(ground: &Ground) {
  ground.agency.supervisors.lock().unwrap().insert(
    "the-chat-agent".into(),
    Supervisor {
      owner_account: Some(OWNER),
    },
  );
  ground.accounts.placements.lock().unwrap().insert(
    OWNER,
    Placement {
      company: unit(COMPANY, "Company"),
      path: vec![unit(COMPANY, "Company"), unit(TEAM, "Team")],
      posts: vec![vec![unit(COMPANY, "Company"), unit(POST, "Post team")]],
    },
  );

  let mut brains = ground.brain.org_brains.lock().unwrap();

  for id in [COMPANY, TEAM, POST] {
    brains.insert((COMPANY, id), id * 10);
  }

  let mut photographs =
    org_memory(12, "Site photographs go to the company drive only.", 9, &["photographs"]);

  photographs.locked = true;
  *ground.brain.org_topics.lock().unwrap() = vec![
    topic("industry", 10, false, vec![org_memory(11, "The company builds.", 5, &["industry"])]),
    topic("photographs", 10, true, vec![photographs.clone()]),
    topic(
      "working-hours",
      30,
      false,
      vec![org_memory(31, "The team works 07:00 to 16:00.", 6, &["working-hours"])],
    ),
  ];

  let mut memories = ground.brain.org_memories.lock().unwrap();

  memories.insert(
    10,
    vec![
      org_memory(11, "The company builds.", 5, &["industry"]),
      photographs,
      org_memory(13, "The company works 08:30 to 17:30.", 6, &["working-hours"]),
    ],
  );

  let mut weekly = org_memory(32, "The weekly report is due on Friday.\nAt three.", 4, &[]);

  weekly.recall_condition = Some("a weekly report comes up".into());
  memories.insert(
    30,
    vec![org_memory(31, "The team works 07:00 to 16:00.", 6, &["working-hours"]), weekly],
  );
}

fn turn() -> Turn {
  Turn {
    chat_id: 7,
    message_id: None,
    speaker_ids: vec![],
    agent: "the-chat-agent".into(),
    audience: Audience::Internal,
    situation: None,
  }
}

fn org_sheet(entries: &[Entry]) -> Option<&Entry> {
  entries.iter().find(|entry| entry.path == SHEET_PATH)
}

#[tokio::test]
async fn a_turn_carries_the_org_sheet_of_the_owners_units_the_farthest_first() {
  let ground = ground("org-sheet", |_| None).await;

  furnish(&ground);

  let entries = handed(&ground.reference, &turn()).await;
  let sheet = org_sheet(&entries).expect("the org sheet");
  let lines: Vec<&str> = sheet.text.lines().collect();

  assert_eq!(sheet.source, Source::Memory);
  assert_eq!(
    &lines[1..],
    [
      "- [#11 Company · industry] The company builds.",
      "- [#12 Company · photographs · locked] Site photographs go to the company drive only.",
      "- [#31 Team · working-hours] The team works 07:00 to 16:00.",
    ]
  );
  // The post's unit off the home path is named first, then the company down to the home unit.
  assert_eq!(*ground.brain.org_topics_asked.lock().unwrap(), [(vec![40, 10, 30], Audience::Internal)]);
}

#[tokio::test]
async fn the_org_sheet_keeps_the_locked_and_the_nearer_lines_within_its_ceiling() {
  let ground = ground("org-ceiling", |_| None).await;

  furnish(&ground);

  let long = "word ".repeat(REFERENCE.organisation_chars / 10);
  {
    let mut topics = ground.brain.org_topics.lock().unwrap();

    topics[0].memories[0].text = long.clone();
    topics[2].memories[0].text = long;
  }

  let entries = handed(&ground.reference, &turn()).await;
  let sheet = org_sheet(&entries).expect("the org sheet");
  let ids: Vec<&str> =
    sheet.text.lines().skip(1).filter_map(|line| line.split_whitespace().nth(1)).collect();

  assert!(sheet.text.chars().count() <= REFERENCE.organisation_chars, "{}", sheet.text.len());
  // The company's long line gives way to the locked rule and the team's nearer one.
  assert_eq!(ids, ["[#12", "[#31"]);
}

#[tokio::test]
async fn the_organisation_group_lists_what_the_sheet_did_not_carry_less_what_another_unit_overrides() {
  let ground = ground("org-group", |_| None).await;

  furnish(&ground);

  let key = ground.reference.brain_key("the-chat-agent").await.unwrap();
  let listed = entries(&ground.reference, &key, 7, "organisation", Some(Audience::Internal))
    .await
    .unwrap();
  let slugs: Vec<&str> = listed.iter().map(|entry| entry.slug.as_str()).collect();

  // The company's working hours stand for nobody, the team's standing in their place; the sheet carried the rest.
  assert_eq!(slugs, ["org-32"]);
  assert_eq!(listed[0].holds, "Team: The weekly report is due on Friday.");
  assert_eq!(listed[0].read_when.as_deref(), Some("a weekly report comes up"));
  assert_eq!(listed[0].path, "organisation/3/32");

  let read = piece(&ground.reference, &key, 7, "organisation", "org-32", None, Some(Audience::Internal))
    .await
    .unwrap();

  assert_eq!(read.text, "From Team:\n\nThe weekly report is due on Friday.\nAt three.");
}

#[tokio::test]
async fn a_supervisor_of_no_account_is_handed_nothing_of_an_organisation() {
  let ground = ground("org-none", |_| None).await;

  furnish(&ground);
  ground.agency.supervisors.lock().unwrap().clear();

  let handed = handed(&ground.reference, &turn()).await;
  let key = ground.reference.brain_key("the-chat-agent").await.unwrap();

  assert!(org_sheet(&handed).is_none(), "{handed:?}");
  assert!(entries(&ground.reference, &key, 7, "organisation", None).await.unwrap().is_empty());
  assert!(ground.brain.org_topics_asked.lock().unwrap().is_empty());
  // No org brain is read, so whom the room calls for is never asked.
  assert!(ground.receiver.audience_asked.lock().unwrap().is_empty());
}

// The company's locked rule on photographs and the team's weekly report marked internal-only.
fn keep_internal(ground: &Ground) {
  ground.brain.org_topics.lock().unwrap()[1].memories[0].internal_only = true;
  ground.brain.org_memories.lock().unwrap().get_mut(&30).unwrap()[1].internal_only = true;
}

#[tokio::test]
async fn an_external_turn_reads_what_stands_for_the_external_audience_less_the_internal_only() {
  let ground = ground("org-external-sheet", |_| None).await;

  furnish(&ground);
  keep_internal(&ground);

  let external = Turn {
    audience: Audience::External,
    ..turn()
  };
  let entries = handed(&ground.reference, &external).await;
  let sheet = org_sheet(&entries).expect("the org sheet");

  assert!(!sheet.text.contains("[#12 "), "{}", sheet.text);
  assert!(sheet.text.contains("[#11 "), "{}", sheet.text);
  assert_eq!(*ground.brain.org_topics_asked.lock().unwrap(), [(vec![40, 10, 30], Audience::External)]);
}

#[tokio::test]
async fn an_external_read_leaves_the_internal_only_org_memories_out_of_the_group_and_its_pieces() {
  let ground = ground("org-external-group", |_| None).await;

  furnish(&ground);
  keep_internal(&ground);

  let key = ground.reference.brain_key("the-chat-agent").await.unwrap();
  let external = Some(Audience::External);

  assert!(entries(&ground.reference, &key, 7, "organisation", external).await.unwrap().is_empty());
  assert!(matches!(
    piece(&ground.reference, &key, 7, "organisation", "org-32", None, external).await,
    Err(Unanswered::NoPiece)
  ));
}

#[tokio::test]
async fn a_read_naming_no_audience_asks_the_receiver_and_reads_external_where_it_cannot_say() {
  let ground = ground("org-room-audience", |_| None).await;

  furnish(&ground);
  keep_internal(&ground);
  ground.receiver.audiences.lock().unwrap().insert(7, Audience::Internal);

  let key = ground.reference.brain_key("the-chat-agent").await.unwrap();
  let held = entries(&ground.reference, &key, 7, "organisation", None).await.unwrap();

  assert_eq!(held.iter().map(|entry| entry.slug.as_str()).collect::<Vec<_>>(), ["org-32"]);

  // The receiver holds no room 8, so the read there is external.
  assert!(entries(&ground.reference, &key, 8, "organisation", None).await.unwrap().is_empty());
  assert_eq!(
    *ground.receiver.audience_asked.lock().unwrap(),
    [(7, "the-chat-agent".to_owned()), (8, "the-chat-agent".to_owned())]
  );
  assert_eq!(
    ground
      .brain
      .org_topics_asked
      .lock()
      .unwrap()
      .iter()
      .map(|(_, audience)| *audience)
      .collect::<Vec<_>>(),
    [Audience::Internal, Audience::External]
  );
}
