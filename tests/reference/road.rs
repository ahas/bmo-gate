//! A turn's reference on the road: the standing memories and the heads of the speakers' sheets first, each gate's
//! picks read through the library they stand in, what each gate was offered, judged and attached written down and the attached rows handed
//! to the brain; a gate switched off asked nothing, a gate left no candidate saying so, a gate with no reading handing
//! over its index, and the knowledge a piece of work is handed.

use std::collections::HashSet;

use gate_policy::prompts;
use gate_policy::reference::REFERENCE;
use gate_ports::brain::Sheet;
use gate_reference::memories::memory_line;
use gate_reference::road::{Turn, held_sheet, select, select_knowledge};
use gate_reference::{Entry, Source};

use crate::fakes::{fragment, memory};
use crate::{Ground, ground, offered_slugs};

fn turn(off: &[&str]) -> Turn {
  Turn {
    chat_id: 7,
    message_lines: vec!["Owner (id 5): Robin, how do deploys go?".into()],
    message_id: Some(9),
    speaker_ids: vec![5, 5],
    situation: None,
    holds: None,
    round: Some("round-1".into()),
    people_spoke: true,
    answered: None,
    off: off.iter().map(|gate| (*gate).to_owned()).collect(),
    lore: false,
    records: true,
  }
}

// A gateway answering a picker yes for the slugs wanted, and the person-book search with the slugs it names.
fn picking(
  wanted: &'static [&'static str],
) -> impl Fn(&gate_ports::gateway::Ask) -> Option<String> + Send + Sync {
  move |ask| {
    let slugs = offered_slugs(&ask.input);

    if slugs.iter().any(|slug| slug.starts_with("person-")) {
      return Some(
        slugs
          .iter()
          .filter(|slug| wanted.contains(&slug.as_str()))
          .cloned()
          .collect::<Vec<_>>()
          .join("\n"),
      );
    }

    Some(
      slugs
        .iter()
        .map(|slug| format!("{slug}: {}", if wanted.contains(&slug.as_str()) { "yes" } else { "no" }))
        .collect::<Vec<_>>()
        .join("\n"),
    )
  }
}

fn furnish(ground: &Ground) {
  let brain = &ground.brain;

  brain.fragments.lock().unwrap().extend([
    fragment("system-document", "structure", "the system's large structure", None, None),
    fragment("room-rule", "greeting", "how this room greets", Some(7), None),
    fragment("library-knowledge", "deploy-notes", "how a deploy goes", None, None),
    fragment("library-knowledge", "kittens", "the office cat", None, None),
    fragment("person-book", "person-5", "Owner", Some(7), Some(5)),
    fragment("person-book", "person-6", "Robin", Some(7), Some(6)),
    fragment("person-book", "person-8", "Sam", Some(7), Some(8)),
  ]);
  brain.documents.lock().unwrap().extend([
    ("deploy-notes".to_owned(), "Deploys go through the testbed.".to_owned()),
    ("greeting".to_owned(), "Greet in one line.".to_owned()),
  ]);
  brain.standing.lock().unwrap().push(memory(
    41,
    "promise",
    "call-back",
    "Call back once the deploy lands.",
  ));
  brain.sheets.lock().unwrap().extend([
    Sheet {
      person: 5,
      path: "rooms/7/people/5/sheet.md".into(),
      text: "- [#1 since 2026-01-02] Runs the deploys.".into(),
    },
    Sheet {
      person: 6,
      path: "rooms/7/people/6/sheet.md".into(),
      text: "- [#2 since 2026-02-03] Keeps the office cat.".into(),
    },
  ]);
  ground
    .receiver
    .names
    .lock()
    .unwrap()
    .extend([(6, "Robin".to_owned()), (8, "Sam".to_owned())]);
  std::fs::create_dir_all(ground.shipped.join("system-document")).unwrap();
  std::fs::write(ground.shipped.join("system-document/structure.md"), "  The structure.\n").unwrap();
}

fn paths(entries: &[Entry]) -> Vec<(&str, Source)> {
  entries.iter().map(|entry| (entry.path.as_str(), entry.source)).collect()
}

#[tokio::test]
async fn a_turns_reference_stands_its_memories_and_sheets_first_then_what_each_gate_picked() {
  let ground =
    ground("turn", picking(&["structure", "greeting", "deploy-notes", "person-6", "memory-41"])).await;

  furnish(&ground);

  let entries = select(&ground.reference, &turn(&[])).await.unwrap();

  assert_eq!(
    paths(&entries),
    [
      ("memories/7", Source::Memory),
      ("rooms/7/people/5/sheet.md", Source::Person),
      ("system-document/structure.md", Source::Document),
      ("knowledge/greeting.md", Source::Rule),
      ("knowledge/deploy-notes.md", Source::Knowledge),
      ("rooms/7/people/6/sheet.md", Source::Person),
    ]
  );
  assert_eq!(entries[1].text, "- [#1 since 2026-01-02] Runs the deploys.");
  assert_eq!(entries[5].text, "- [#2 since 2026-02-03] Keeps the office cat.");
  assert_eq!(entries[2].text, "The structure.");
  assert!(entries[0].text.contains("- #41 promise"));

  let hits: HashSet<String> =
    ground.brain.hits.lock().unwrap().iter().map(|hit| hit.slug.clone()).collect();

  assert_eq!(
    hits,
    ["structure", "greeting", "deploy-notes", "person-6", "memory-41"]
      .map(str::to_owned)
      .into()
  );

  let scratch = &ground.scratch;

  assert_eq!(
    scratch
      .count("SELECT count(*) FROM reference_offers WHERE round = 'round-1'", vec![])
      .await,
    5
  );
  assert_eq!(
    scratch
      .count("SELECT count(*) FROM judgements WHERE round = 'round-1' AND message_id = 9", vec![])
      .await,
    5
  );
  assert_eq!(
    scratch
      .texts("SELECT slug FROM reference_verdicts WHERE attached = 1 ORDER BY slug", vec![])
      .await,
    ["deploy-notes", "greeting", "memory-41", "person-6", "structure"]
  );
  assert_eq!(
    scratch
      .texts("SELECT slug FROM reference_verdicts WHERE llm = 0 ORDER BY slug", vec![])
      .await,
    ["kittens"]
  );
  // The person-book search is offered the speaker beside the others, whose whole sheet it may pick in place of the
  // head, narrowed to whom the turn names.
  assert_eq!(
    scratch
      .texts(
        "SELECT held || ' ' || slugs FROM reference_offers WHERE stage = 'people-search'",
        vec![]
      )
      .await,
    ["3 [\"person-5\",\"person-6\"]"]
  );
  assert_eq!(
    scratch.count("SELECT count(*) FROM gate_roads WHERE round = 'round-1'", vec![]).await,
    5
  );
  assert_eq!(
    scratch
      .texts("SELECT stage || ' ' || verdict FROM judgements ORDER BY stage", vec![])
      .await,
    [
      "library-knowledge PICK: deploy-notes",
      "people-search PICK: person-6",
      "room-memories PICK: memory-41",
      "room-rules PICK: greeting",
      "system-documents PICK: structure"
    ]
  );

  // Every picker's request closes on its own answer file, right after the turn's messages.
  let asked = ground.gateway.asked.lock().unwrap();

  for (stage, cap) in [
    ("system-documents", ""),
    ("room-rules", ""),
    ("library-knowledge", ""),
    ("people-search", "4"),
    ("room-memories", ""),
  ] {
    let answer = prompts::render(prompts::answer(stage).unwrap(), &[("selectionCap", cap)]);
    let closing = format!("how do deploys go?\n\n{answer}");

    assert!(asked.iter().any(|ask| ask.input.ends_with(&closing)), "{stage}");
  }
}

#[tokio::test]
async fn a_gate_switched_off_is_not_asked_and_a_gate_left_no_candidate_says_so() {
  let ground = ground("off", picking(&["deploy-notes"])).await;

  ground.brain.fragments.lock().unwrap().push(fragment(
    "library-knowledge",
    "deploy-notes",
    "how a deploy goes",
    None,
    None,
  ));
  ground
    .brain
    .documents
    .lock()
    .unwrap()
    .insert("deploy-notes".into(), "Deploys go through the testbed.".into());

  let entries = select(&ground.reference, &turn(&["library-knowledge"])).await.unwrap();

  assert!(entries.is_empty());
  assert!(ground.gateway.asked.lock().unwrap().is_empty());
  assert_eq!(
    ground
      .scratch
      .texts("SELECT stage || ' ' || verdict FROM judgements ORDER BY stage", vec![])
      .await,
    [
      "people-search SKIP: no candidates",
      "room-memories SKIP: no candidates",
      "room-rules SKIP: no candidates",
      "system-documents SKIP: no candidates"
    ]
  );
}

#[tokio::test]
async fn a_gate_with_no_reading_hands_over_its_index() {
  let ground = ground("unread", |_| Some("I cannot tell.".into())).await;

  ground.brain.fragments.lock().unwrap().push(fragment(
    "library-knowledge",
    "deploy-notes",
    "how a deploy goes",
    None,
    None,
  ));

  let entries = select(&ground.reference, &turn(&[])).await.unwrap();

  assert_eq!(paths(&entries), [("knowledge/index.md", Source::Knowledge)]);
  assert_eq!(entries[0].text, "- deploy-notes \u{2014} how a deploy goes");
  assert!(ground.brain.hits.lock().unwrap().is_empty());
  assert_eq!(
    ground
      .scratch
      .texts(
        "SELECT verdict || ' / ' || detail FROM judgements WHERE stage = 'library-knowledge'",
        vec![]
      )
      .await,
    ["UNREADABLE / I cannot tell."]
  );
}

#[tokio::test]
async fn every_picker_answering_a_sentence_writes_unreadable_with_the_answer_as_its_detail() {
  let ground = ground("sentence", |_| Some("Deploys? They go through the testbed, boss.".into())).await;

  furnish(&ground);
  select(&ground.reference, &turn(&[])).await.unwrap();

  assert_eq!(
    ground
      .scratch
      .texts(
        "SELECT stage || ' ' || verdict || ' / ' || detail FROM judgements ORDER BY stage",
        vec![]
      )
      .await,
    [
      "library-knowledge UNREADABLE / Deploys? They go through the testbed, boss.",
      "people-search UNREADABLE / Deploys? They go through the testbed, boss.",
      "room-memories UNREADABLE / Deploys? They go through the testbed, boss.",
      "room-rules UNREADABLE / Deploys? They go through the testbed, boss.",
      "system-documents UNREADABLE / Deploys? They go through the testbed, boss."
    ]
  );
}

#[tokio::test]
async fn a_piece_of_work_is_handed_the_knowledge_its_lines_call_for_and_nothing_is_written_down() {
  let ground = ground("work", picking(&["deploy-notes"])).await;

  furnish(&ground);

  let entries =
    select_knowledge(&ground.reference, "the-chat-agent", 7, &["Deploy the release.".into()]).await;

  assert_eq!(paths(&entries), [("knowledge/deploy-notes.md", Source::Knowledge)]);
  assert_eq!(ground.brain.hits.lock().unwrap().len(), 1);
  assert_eq!(ground.scratch.count("SELECT count(*) FROM judgements", vec![]).await, 0);
  assert_eq!(ground.scratch.count("SELECT count(*) FROM reference_offers", vec![]).await, 0);
  assert!(select_knowledge(&ground.reference, "the-chat-agent", 7, &[]).await.is_empty());
}

// The lore of the agent's brain in two sections, and the body of one of its pieces.
fn furnish_lore(ground: &Ground) {
  let piece = |slug: &str, title: &str, section: &str| {
    let mut row = fragment("lore", slug, title, None, None);

    row.section = Some(section.to_owned());
    row
  };

  ground.brain.fragments.lock().unwrap().extend([
    piece("harbour", "the harbour", "lore"),
    piece("weather", "the town's weather", "lore/The town"),
  ]);
  ground
    .brain
    .lore
    .lock()
    .unwrap()
    .insert("harbour".into(), "The harbour is small.".into());
}

fn reading_lore(lore: bool) -> Turn {
  Turn { lore, ..turn(&[]) }
}

#[tokio::test]
async fn a_room_that_reads_the_lore_is_offered_the_brains_lore_and_handed_a_piece_through_the_brain() {
  let ground = ground("lore", picking(&["harbour"])).await;

  furnish_lore(&ground);

  let entries = select(&ground.reference, &reading_lore(true)).await.unwrap();

  assert_eq!(paths(&entries), [("lore/harbour.md", Source::Document)]);
  assert_eq!(entries[0].text, "The harbour is small.");
  assert_eq!(*ground.brain.lore_asked.lock().unwrap(), [vec!["harbour".to_owned()]]);

  let asked = ground.gateway.asked.lock().unwrap();

  assert_eq!(asked.len(), 1);
  assert_eq!(offered_slugs(&asked[0].input), ["harbour", "weather"]);
  assert_eq!(
    ground
      .brain
      .hits
      .lock()
      .unwrap()
      .iter()
      .map(|hit| hit.slug.as_str())
      .collect::<Vec<_>>(),
    ["harbour"]
  );
}

#[tokio::test]
async fn a_room_that_reads_no_lore_is_offered_none_of_it() {
  let ground = ground("no-lore", picking(&["harbour"])).await;

  furnish_lore(&ground);

  let entries = select(&ground.reference, &reading_lore(false)).await.unwrap();

  assert!(entries.is_empty());
  assert!(ground.gateway.asked.lock().unwrap().is_empty());
  assert!(ground.brain.lore_asked.lock().unwrap().is_empty());
  assert_eq!(
    ground
      .scratch
      .texts("SELECT verdict FROM judgements WHERE stage = 'system-documents'", vec![])
      .await,
    ["SKIP: no candidates"]
  );
}

#[tokio::test]
async fn the_lore_with_no_reading_is_handed_over_one_index_a_section() {
  let ground = ground("lore-unread", |_| Some("I cannot tell.".into())).await;

  furnish_lore(&ground);

  let entries = select(&ground.reference, &reading_lore(true)).await.unwrap();

  assert_eq!(paths(&entries), [("lore", Source::Document), ("lore/The town", Source::Document)]);
  assert_eq!(entries[0].text, "- harbour \u{2014} the harbour");
  assert_eq!(entries[1].text, "- weather \u{2014} the town's weather");
}

#[test]
fn a_sheet_over_its_ceiling_keeps_its_lines_from_the_top() {
  let line = |at: usize| format!("- [#{at} since 2026-01-02] {}", "x".repeat(990));
  let text = (1..=40).map(line).collect::<Vec<_>>().join("\n");
  let held = held_sheet(&text);
  let lines: Vec<&str> = held.split('\n').collect();

  assert!(held.chars().count() <= REFERENCE.sheet_chars);
  assert_eq!(lines[0], line(1));
  assert_eq!(*lines.last().unwrap(), line(lines.len()));
  assert!(held.chars().count() + line(lines.len() + 1).chars().count() + 1 > REFERENCE.sheet_chars);
  assert_eq!(held_sheet("- [#1 since 2026-01-02] Short.\n"), "- [#1 since 2026-01-02] Short.");
  assert_eq!(held_sheet(&"x".repeat(REFERENCE.sheet_chars + 1)), "");
}

// A speaker's sheet of so many facts, one line each.
fn long_sheet(person: i64, facts: usize) -> Sheet {
  Sheet {
    person,
    path: format!("rooms/7/people/{person}/sheet.md"),
    text: (1..=facts)
      .map(|at| format!("- [#{at} since 2026-01-02] Fact {at}."))
      .collect::<Vec<_>>()
      .join("\n"),
  }
}

#[tokio::test]
async fn a_speakers_sheet_attaches_its_head_and_the_search_alone_attaches_the_rest() {
  let headed = ground("sheet-head", picking(&[])).await;

  furnish(&headed);
  headed.brain.sheets.lock().unwrap()[0] = long_sheet(5, 30);

  let entries = select(&headed.reference, &turn(&[])).await.unwrap();
  let head = entries.iter().find(|entry| entry.path == "rooms/7/people/5/sheet.md").unwrap();

  assert_eq!(head.text.lines().count(), REFERENCE.sheet_lines);
  assert_eq!(head.text.lines().next(), Some("- [#1 since 2026-01-02] Fact 1."));

  let whole = ground("sheet-whole", picking(&["person-5"])).await;

  furnish(&whole);
  whole.brain.sheets.lock().unwrap()[0] = long_sheet(5, 30);

  let entries = select(&whole.reference, &turn(&[])).await.unwrap();
  let sheets: Vec<&Entry> =
    entries.iter().filter(|entry| entry.path == "rooms/7/people/5/sheet.md").collect();

  assert_eq!(sheets.len(), 1, "{entries:?}");
  assert_eq!(sheets[0].text.lines().count(), 30);
}

// A room's memories: errands whose event came at different moments, one more of them than the due count, and rows
// waiting on nothing.
fn furnish_memories(ground: &Ground, words: &str) {
  let mut rows: Vec<_> = (0..=REFERENCE.memories.due as i64)
    .map(|at| {
      let mut row = memory(40 + at, "promise", "", "Tell them once the job ends.");

      row.event_met_at = Some(100 + at);
      row
    })
    .collect();

  rows.extend((51..=54).map(|id| memory(id, "followup", "", &format!("{words} {id}."))));
  *ground.brain.standing.lock().unwrap() = rows;
}

// The numbers of the rows an entry carries, in its order.
fn carried(entry: &Entry) -> Vec<i64> {
  entry
    .text
    .lines()
    .filter_map(|line| line.strip_prefix("- #"))
    .filter_map(|line| line.split_whitespace().next())
    .filter_map(|id| id.parse().ok())
    .collect()
}

fn memories_of(entries: &[Entry]) -> Option<&Entry> {
  entries.iter().find(|entry| entry.path == "memories/7")
}

#[tokio::test]
async fn due_memories_attach_unpicked_and_the_rest_only_where_the_memory_picker_picks_them() {
  let ground = ground("memories", picking(&["memory-52", "memory-53"])).await;

  furnish_memories(&ground, "Follow up on matter");

  let entries = select(&ground.reference, &turn(&[])).await.unwrap();
  let entry = memories_of(&entries).expect("the memories entry");
  let due = REFERENCE.memories.due as i64;
  let mut expected: Vec<i64> = (1..=due).rev().map(|at| 40 + at).collect();

  expected.extend([52, 53]);

  assert_eq!(carried(entry), expected);
  assert!(entry.text.contains(&format!("of the {} open items", due + 5)));
  assert!(
    entry
      .text
      .ends_with("- … 3 more open here, not carried this turn: brain_list with chat 7")
  );

  // The due row past the count is offered with the rows waiting on nothing, in the brain's order.
  assert_eq!(
    ground
      .scratch
      .texts("SELECT slugs FROM reference_offers WHERE stage = 'room-memories'", vec![])
      .await,
    ["[\"memory-40\",\"memory-51\",\"memory-52\",\"memory-53\",\"memory-54\"]"]
  );

  let hits: Vec<String> = ground.brain.hits.lock().unwrap().iter().map(|hit| hit.slug.clone()).collect();

  assert_eq!(hits, ["memory-52", "memory-53"]);
  assert_eq!(
    ground
      .scratch
      .texts(
        "SELECT slug FROM reference_verdicts WHERE stage = 'room-memories' AND attached = 1 ORDER BY slug",
        vec![]
      )
      .await,
    ["memory-52", "memory-53"]
  );
}

#[tokio::test]
async fn what_the_memory_picker_picks_is_held_to_its_allowance() {
  let ground =
    ground("memories-allowance", picking(&["memory-51", "memory-52", "memory-53", "memory-54"])).await;
  let words = "w".repeat(REFERENCE.memories.budget / 3);

  furnish_memories(&ground, &words);

  let entries = select(&ground.reference, &turn(&[])).await.unwrap();
  let picked: Vec<i64> =
    carried(memories_of(&entries).unwrap()).into_iter().filter(|id| *id > 50).collect();
  let line = memory_line(&memory(51, "followup", "", &format!("{words} 51.")));

  assert_eq!(picked.len(), REFERENCE.memories.budget / gate_markup::js::units(&line));
  assert_eq!(picked, [51, 52][..picked.len()]);
}

#[tokio::test]
async fn nothing_due_and_nothing_picked_carries_no_memories_and_a_failed_pick_hands_over_no_index() {
  let quiet = ground("memories-none", picking(&[])).await;

  quiet.brain.standing.lock().unwrap().push(memory(51, "followup", "", "Follow up."));

  assert!(memories_of(&select(&quiet.reference, &turn(&[])).await.unwrap()).is_none());

  let failed = ground("memories-unread", |_| Some("I cannot tell.".into())).await;

  furnish_memories(&failed, "Follow up on matter");

  let entries = select(&failed.reference, &turn(&[])).await.unwrap();

  assert_eq!(carried(memories_of(&entries).unwrap()).len(), REFERENCE.memories.due);
  assert!(!entries.iter().any(|entry| entry.path.starts_with("memories/7/")), "{entries:?}");
}

#[tokio::test]
async fn a_turn_with_no_line_carries_the_due_memories_and_asks_no_picker() {
  let ground = ground("memories-touch", picking(&["memory-51"])).await;

  furnish_memories(&ground, "Follow up on matter");

  let touch = Turn {
    message_lines: vec![],
    people_spoke: false,
    ..turn(&[])
  };
  let entries = select(&ground.reference, &touch).await.unwrap();

  assert_eq!(carried(memories_of(&entries).unwrap()).len(), REFERENCE.memories.due);
  assert!(ground.gateway.asked.lock().unwrap().is_empty());
}
