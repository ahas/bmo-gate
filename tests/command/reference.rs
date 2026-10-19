//! The reference road's benches over a stand-in brain and receiver: the narrowing measured on stored turns, a
//! stored turn's inputs as each gate would be handed them, judged turns replayed, the attachments weighed against
//! the use judge's word, the two roads set side by side, and the classifier's stored runs compared with today's
//! gates.

use std::collections::HashSet;

use gate_command::reference::compare::{
  After, Before, Compared, Counts, SetShape, Shapes, Spread, StoredRun, Timing, Wanting, band_of, compare,
  cut_by_gate, figures_of, index_text_of, read_prompt, shape_of, spread_sample, stored_runs, timing_of,
};
use gate_command::reference::inputs::{Work, answer};
use gate_command::reference::narrowing::narrowing;
use gate_command::reference::replay::{judged_turns, replay_all, spread, use_of};
use gate_command::reference::roads::roads;
use gate_command::reference::waste::{Labels, day_start, waste};
use gate_ports::gateway::Ask;
use gate_ports::receiver::{Message, RoomTitle};
use gate_reference::pick::Candidate;
use gate_reference::road;
use serde_json::{Value, json};

use crate::units::fragment;
use crate::{RoadGround, road_ground};

/// The slugs a picker's index offers, in order.
fn offered_slugs(input: &str) -> Vec<String> {
  input
    .lines()
    .filter_map(|line| line.strip_prefix("- "))
    .filter_map(|line| line.split_whitespace().next())
    .map(str::to_owned)
    .collect()
}

/// A gateway answering a picker yes for the slugs wanted and no for the rest, and nothing to any other gate.
fn picking(wanted: &'static [&'static str]) -> impl Fn(&Ask) -> Option<String> + Send + Sync {
  move |ask| {
    let slugs = offered_slugs(&ask.input);

    (!slugs.is_empty()).then(|| {
      slugs
        .iter()
        .map(|slug| format!("{slug}: {}", if wanted.contains(&slug.as_str()) { "yes" } else { "no" }))
        .collect::<Vec<_>>()
        .join("\n")
    })
  }
}

// The brain holding a room's knowledge, and the receiver keeping a person's question in room 7 as message 9.
fn furnish(ground: &RoadGround) {
  ground.brain.fragments.lock().unwrap().extend([
    fragment("library-knowledge", "deploy-notes", "how a deploy goes", None, None),
    fragment("library-knowledge", "kittens", "the office cat", None, None),
  ]);
  ground
    .brain
    .documents
    .lock()
    .unwrap()
    .insert("deploy-notes".to_owned(), "Deploys go through the testbed.".to_owned());
  ground
    .receiver
    .messages
    .lock()
    .unwrap()
    .insert((7, 9), message(Some(5), "Owner", "how do deploys go?"));
}

fn message(sender: Option<i64>, name: &str, text: &str) -> Message {
  Message {
    sender,
    sender_name: Some(name.to_owned()),
    sent_at: 1_700_000_000,
    text: text.to_owned(),
  }
}

async fn verdict(ground: &RoadGround, stage: &str, message: i64, slug: &str, attached: bool) {
  ground
    .scratch
    .run(
      r#"INSERT INTO reference_verdicts (stage, chat_id, message_id, slug, llm, attached, created_at) VALUES ($1, 7, $2, $3, 1, $4, 100)"#,
      vec![stage.into(), message.into(), slug.into(), i64::from(attached).into()],
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn the_narrowing_is_measured_on_each_room_s_answered_turns_read_through_the_receiver() {
  let ground = road_ground("narrowing", |_| None).await;

  furnish(&ground);
  verdict(&ground, "library-knowledge", 9, "deploy-notes", true).await;
  verdict(&ground, "library-knowledge", 10, "kittens", false).await;

  let lines = narrowing(&ground.reference, None, 20, false).await.unwrap();

  assert_eq!(lines[0], "chat 7 \u{b7} 1 turns");
  assert!(
    lines.iter().any(|line| line.starts_with("  library-knowledge: held 2 \u{b7} asked ")),
    "{lines:?}"
  );

  let json: Value =
    serde_json::from_str(&narrowing(&ground.reference, Some(7), 2, true).await.unwrap()[0]).unwrap();
  let measured = json.as_array().unwrap();

  assert!(!measured.is_empty());
  assert!(measured.iter().all(|one| one["chatId"] == 7 && one["messageId"] == 9));
  assert!(measured.iter().any(|one| one["stage"] == "library-knowledge" && one["held"] == 2));
}

#[tokio::test]
async fn a_stored_turn_is_answered_with_each_gate_s_input_and_the_pieces_asked_for() {
  let ground = road_ground("inputs", |_| None).await;

  furnish(&ground);
  *ground.receiver.own.lock().unwrap() = Some(42);
  ground
    .receiver
    .messages
    .lock()
    .unwrap()
    .insert((7, 11), message(Some(42), "Agent", "I will look into the deploy."));

  let input = [
    json!({ "chatId": 7, "messageIds": [9], "instructions": "Mind the deploy window.", "answered": "Owner (id 5): earlier", "bodies": { "library-knowledge": ["deploy-notes", "nowhere"] } }),
    json!({ "chatId": 7, "messageIds": [9, 99] }),
    json!({ "chatId": 7, "work": { "kind": "search", "query": "deploy notes" } }),
    json!({ "chatId": 7, "messageIds": [11] }),
  ]
  .iter()
  .map(Value::to_string)
  .collect::<Vec<_>>()
  .join("\n");
  let mut out = vec![];

  answer(&ground.reference, &input, &mut out).await.unwrap();

  let lines: Vec<Value> = String::from_utf8(out)
    .unwrap()
    .lines()
    .map(|line| serde_json::from_str(line).unwrap())
    .collect();

  assert_eq!(lines.len(), 4);

  let turn = &lines[0];
  let knowledge = turn["gates"]
    .as_array()
    .unwrap()
    .iter()
    .find(|gate| gate["gate"] == "library-knowledge")
    .unwrap();

  assert_eq!(turn["instructions"], "Mind the deploy window.");
  assert_eq!(knowledge["held"], 2);
  assert!(
    knowledge["candidates"]
      .as_array()
      .unwrap()
      .iter()
      .any(|one| one["slug"] == "deploy-notes")
  );
  assert!(
    knowledge["request"]["state"]
      .as_str()
      .unwrap()
      .contains("Owner (id 5): how do deploys go?")
  );
  assert!(
    knowledge["request"]["state"]
      .as_str()
      .unwrap()
      .contains("quiet instruction from the bot: Mind the deploy window.")
  );
  assert_eq!(
    turn["pieces"],
    json!([
      { "gate": "library-knowledge", "slug": "deploy-notes", "about": "how a deploy goes", "body": "Deploys go through the testbed." },
      { "gate": "library-knowledge", "slug": "nowhere", "about": null, "body": null },
    ])
  );
  assert_eq!(lines[1]["missing"], true);
  assert!(lines[1].get("gates").is_none());
  assert_eq!(lines[2]["work"], json!({ "kind": "search", "query": "deploy notes" }));
  assert_eq!(lines[2]["gates"][0]["gate"], "library-knowledge");
  assert!(lines[3].get("missing").is_none());
  assert!(lines[3]["gates"].as_array().unwrap().iter().all(|gate| gate["gate"] != "people-search"));
}

#[test]
fn a_piece_of_work_is_asked_by_its_own_run_s_lines() {
  let search: Work = serde_json::from_str(r#"{"kind": "search", "query": "release notes"}"#).unwrap();
  let job: Work = serde_json::from_str(
    r#"{"kind": "job", "title": "Fix it", "instruction": "Fix the road", "requester": "Owner", "requesterId": 7}"#,
  )
  .unwrap();

  assert_eq!(search.lines(), vec![road::instruction_line("release notes")]);
  assert_eq!(job.lines(), vec![road::message_line("Owner", Some(7), "Fix it\nFix the road")]);
}

#[test]
fn a_judged_turn_from_the_record_is_read_by_its_room_and_message() {
  let judged = judged_turns(concat!(
    r#"{"id": "-7:3", "source": "record", "candidates": [{"gate": "room-rules", "slug": "greeting", "attached": true, "label": "used"}, {"gate": "room-rules", "slug": "other", "attached": false, "label": null}]}"#,
    "\n",
    r#"{"id": "-7:4", "source": "import", "candidates": []}"#,
    "\n",
    r#"{"id": "work:9", "source": "record", "candidates": []}"#,
  ))
  .unwrap();

  assert_eq!(judged.len(), 1);
  assert_eq!((judged[0].chat_id, judged[0].message_id), (-7, 3));
  assert_eq!(judged[0].then, vec![("room-rules".to_owned(), "greeting".to_owned())]);
  assert_eq!(judged[0].labels.len(), 1);

  let turns: Vec<usize> = (0..10).collect();

  assert_eq!(spread(&turns, 5), vec![0, 2, 4, 6, 8]);
  assert_eq!(spread(&turns, 20), turns);
  assert_eq!(
    [Some("used"), Some("needed"), Some("related"), Some("not-needed"), None].map(use_of),
    ["used", "used", "not used", "not used", "unknown"]
  );
}

#[tokio::test]
async fn judged_turns_are_replayed_on_today_s_road_and_a_turn_whose_message_is_gone_is_passed_over() {
  let ground = road_ground("replay", picking(&["deploy-notes"])).await;

  furnish(&ground);

  let judged = judged_turns(
    &[
      json!({ "id": "7:9", "source": "record", "candidates": [{ "gate": "library-knowledge", "slug": "deploy-notes", "attached": true, "label": "used" }] }),
      json!({ "id": "7:10", "source": "record", "candidates": [] }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n"),
  )
  .unwrap();
  let out = crate::folder("replay-out").join("replayed.json");
  let lines = replay_all(&ground.reference, &judged, Some(&out)).await.unwrap();
  let written: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();

  assert!(lines[0].starts_with("turns 1 \u{b7} road time per turn, middle "), "{lines:?}");
  assert!(lines.contains(&"library-knowledge | 1 | 1 | 1 | 1 | 0 | 0".to_owned()), "{lines:?}");
  assert!(lines.contains(&"library-knowledge \u{b7} deploy-notes | 1 | 1".to_owned()));
  assert_eq!(lines.last().unwrap(), "1 turns passed over: the receiver keeps no such message");
  assert_eq!(
    written[0]["now"],
    json!([{ "gate": "library-knowledge", "slug": "deploy-notes", "use": "used" }])
  );
  assert_eq!(ground.scratch.count("SELECT count(*) FROM reference_offers", vec![]).await, 0);
  assert_eq!(ground.scratch.count("SELECT count(*) FROM reference_verdicts", vec![]).await, 0);
}

#[tokio::test]
async fn each_attached_piece_is_weighed_by_its_body_against_what_the_answer_used() {
  let ground = road_ground("waste", |_| None).await;

  furnish(&ground);
  verdict(&ground, "library-knowledge", 9, "deploy-notes", true).await;
  verdict(&ground, "library-knowledge", 10, "deploy-notes", true).await;
  verdict(&ground, "library-knowledge", 10, "kittens", false).await;

  for ms in [1_000, 3_000] {
    ground
      .scratch
      .run(
        r#"INSERT INTO judgements (chat_id, stage, verdict, created_at, ms) VALUES (7, 'library-knowledge', 'deploy-notes', 100, $1)"#,
        vec![i64::from(ms).into()],
      )
      .await
      .unwrap();
  }

  let labels = Labels::of(
    &[
      json!({ "id": "7:9", "candidates": [{ "gate": "library-knowledge", "slug": "deploy-notes", "attached": true, "label": "unused" }] }),
      json!({ "id": "7:10", "candidates": [{ "gate": "library-knowledge", "slug": "deploy-notes", "attached": true, "label": "used" }] }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n"),
  )
  .unwrap();
  let lines = waste(&ground.reference, &labels, 0, 25, false).await.unwrap();

  assert_eq!(lines[1], "library-knowledge | deploy-notes | 2 | 2 | 1 | 0 | 1 | 50% | 31 | 21 | 10");
  assert!(
    lines.contains(&"turns 2 \u{b7} tokens carried 21 \u{b7} wasted 10 (5 a turn)".to_owned()),
    "{lines:?}"
  );
  assert!(
    lines.contains(&"a turn's own prompt: unavailable, since no unit keeps the usage record".to_owned())
  );
  assert!(lines.last().unwrap().contains("library-knowledge 3.0s / 3.0s"), "{lines:?}");

  let json: Value =
    serde_json::from_str(&waste(&ground.reference, &labels, 0, 25, true).await.unwrap()[0]).unwrap();

  assert_eq!(json["pieces"][0]["chars"], 31);
  assert_eq!(json["summary"]["gateWaste"]["library-knowledge"], 0.5);
  assert_eq!(waste(&ground.reference, &labels, 200, 25, false).await.unwrap()[1], "");
}

#[test]
fn a_since_is_a_day_written_in_full_starting_in_the_owner_s_time() {
  let first = day_start("2026-09-23").unwrap();

  assert_eq!(day_start("2026-09-24").unwrap() - first, 86_400);
  assert_eq!(first % 86_400, 15 * 3_600);
  assert_eq!(day_start("2026-9-23"), None);
  assert_eq!(day_start("yesterday"), None);
}

#[tokio::test]
async fn the_rows_and_the_shipped_index_files_offer_the_system_documents_alike_or_say_where_they_part() {
  let ground = road_ground("roads", |_| None).await;
  let mut structure = fragment("system-document", "structure", "the system's large structure", None, None);

  structure.path = "STRUCTURE.md".to_owned();
  ground.brain.fragments.lock().unwrap().push(structure);
  ground.receiver.rooms.lock().unwrap().push(RoomTitle {
    chat_id: 7,
    title: Some("A room".into()),
    senders: vec![5],
  });
  std::fs::create_dir_all(ground.shipped.join("docs")).unwrap();
  std::fs::write(ground.shipped.join("STRUCTURE.md"), "The structure.").unwrap();
  std::fs::write(
    ground.shipped.join("docs").join("reference-index.md"),
    "- structure \u{2014} the system's large structure\n",
  )
  .unwrap();

  let alike = roads(&ground.reference, false).await.unwrap();

  assert_eq!(alike[0], "rooms compared: 1 \u{b7} candidates offered on the row road: 1");
  assert!(
    alike
      .iter()
      .filter(|line| line.contains("unavailable: its index files are the brain's"))
      .count()
      == 3
  );
  assert_eq!(
    alike.last().unwrap(),
    "the two roads offer the same candidates in the same order, resolving to the same bodies"
  );

  std::fs::write(
    ground.shipped.join("docs").join("reference-index.md"),
    "- structure \u{2014} the system's large structure\n- wording \u{2014} how words are chosen\n",
  )
  .unwrap();

  let apart = roads(&ground.reference, false).await.unwrap();

  assert!(apart.contains(&"chat 7 \u{b7} system-documents".to_owned()), "{apart:?}");
  assert!(
    apart.contains(&"  only the files offer: wording \u{2014} how words are chosen [no body]".to_owned())
  );
  assert_eq!(apart.last().unwrap(), "1 gates differ");

  let json: Value = serde_json::from_str(&roads(&ground.reference, true).await.unwrap()[0]).unwrap();

  assert_eq!(json["unavailable"], json!(["room-rules", "library-knowledge", "people-search"]));
}

fn run() -> StoredRun {
  StoredRun {
    chat_id: -7,
    ended_at: 1_000,
    prompt: "INDEX:\n- a \u{2014} one\n\nMESSAGES:\nOwner: hello".into(),
    answer: "none".into(),
  }
}

fn offered() -> Vec<(String, HashSet<String>)> {
  [
    ("system-documents", vec!["structure", "wording"]),
    ("room-rules", vec!["greeting"]),
    ("library-knowledge", vec!["deploy-rule"]),
  ]
  .into_iter()
  .map(|(stage, slugs)| (stage.to_owned(), slugs.into_iter().map(str::to_owned).collect()))
  .collect()
}

fn candidate(slug: &str, about: &str) -> Candidate {
  Candidate {
    slug: slug.into(),
    about: about.into(),
  }
}

fn slugs(slugs: &[&str]) -> Vec<String> {
  slugs.iter().map(|slug| (*slug).to_owned()).collect()
}

#[test]
fn a_stored_run_is_read_as_its_index_and_messages_and_a_prompt_of_another_shape_as_nothing() {
  assert_eq!(
    read_prompt("INDEX:\n- a \u{2014} one\n- b \u{2014} two\n\nMESSAGES:\nOwner: hello\nSomeone else: yes"),
    Some((
      "- a \u{2014} one\n- b \u{2014} two".to_owned(),
      slugs(&["Owner: hello", "Someone else: yes"])
    ))
  );
  assert_eq!(read_prompt("no idea what this says"), None);
  assert_eq!(
    stored_runs(r#"{"chatId": -7, "endedAt": 1000, "prompt": "p", "answer": "a"}"#).unwrap()[0].ended_at,
    1_000
  );
  assert!(stored_runs("not a run").is_err());
}

#[test]
fn each_candidate_goes_to_the_gate_offering_its_slug_and_one_no_gate_offers_is_named() {
  let cut = cut_by_gate(
    run(),
    &offered(),
    &[
      candidate("greeting", "hello"),
      candidate("structure", "shape"),
      candidate("deploy-rule", "deploy"),
    ],
    slugs(&["Owner: hello"]),
  );
  let by_gate: Vec<(String, Vec<String>)> = cut
    .by_gate
    .iter()
    .map(|(stage, candidates)| (stage.clone(), candidates.iter().map(|one| one.slug.clone()).collect()))
    .collect();

  assert_eq!(
    by_gate,
    vec![
      ("system-documents".to_owned(), slugs(&["structure"])),
      ("room-rules".to_owned(), slugs(&["greeting"])),
      ("library-knowledge".to_owned(), slugs(&["deploy-rule"])),
    ]
  );
  assert!(cut.unattributed.is_empty());

  let gone = cut_by_gate(
    run(),
    &offered(),
    &[candidate("structure", "shape"), candidate("gone", "gone now")],
    vec![],
  );

  assert_eq!(gone.unattributed, slugs(&["gone"]));
  assert_eq!(
    index_text_of(&[candidate("structure", "shape"), candidate("wording", "words")]),
    "- structure \u{2014} shape\n- wording \u{2014} words"
  );
}

#[test]
fn a_pick_moved_as_the_two_sets_stand_to_each_other() {
  assert_eq!(shape_of(&slugs(&["a", "b"]), &slugs(&["b", "a"])), SetShape::Equal);
  assert_eq!(shape_of(&[], &[]), SetShape::Equal);
  assert_eq!(shape_of(&slugs(&["a"]), &slugs(&["a", "b"])), SetShape::Superset);
  assert_eq!(shape_of(&slugs(&["a", "b"]), &slugs(&["a"])), SetShape::Subset);
  assert_eq!(shape_of(&slugs(&["a"]), &slugs(&["b"])), SetShape::Disjoint);
  assert_eq!(shape_of(&slugs(&["a"]), &[]), SetShape::Subset);
  assert_eq!(shape_of(&[], &slugs(&["a"])), SetShape::Superset);
  assert_eq!(shape_of(&slugs(&["a", "b"]), &slugs(&["b", "c"])), SetShape::Overlapping);
}

#[test]
fn the_sample_spreads_over_each_cell_the_same_way_every_time_and_bands_the_counts() {
  let cells: Vec<(&str, usize)> =
    (0..20).map(|index| (if index < 12 { "one" } else { "two" }, index)).collect();
  let cell = |one: &(&str, usize)| one.0.to_owned();
  let taken = spread_sample(&cells, cell, 3);

  assert_eq!(taken, spread_sample(&cells, cell, 3));
  assert_eq!(
    taken.iter().filter(|one| one.0 == "one").map(|one| one.1).collect::<Vec<_>>(),
    vec![0, 4, 8]
  );
  assert_eq!(taken.iter().filter(|one| one.0 == "two").count(), 3);

  let two: Vec<(&str, usize)> = cells.into_iter().filter(|one| one.0 == "two").collect();

  assert_eq!(spread_sample(&two, |one| one.0.to_owned(), 20).len(), 8);
  assert_eq!([7, 9, 10, 19, 20, 80].map(band_of), ["07-09", "07-09", "10-19", "10-19", "20+", "20+"]);
}

#[test]
fn a_run_is_timed_by_its_room_s_nearest_judgement_or_left_untimed() {
  let timings: Vec<Timing> = [(-7, 990, 1_200), (-7, 1_002, 900), (-8, 1_000, 50)]
    .into_iter()
    .map(|(chat_id, at, ms)| Timing { chat_id, at, ms })
    .collect();

  assert_eq!(timing_of(&run(), &timings), Some(900));
  assert_eq!(
    timing_of(
      &StoredRun {
        ended_at: 5_000,
        ..run()
      },
      &timings
    ),
    None
  );
  assert_eq!(
    timing_of(
      &StoredRun {
        chat_id: -9,
        ..run()
      },
      &timings
    ),
    None
  );
}

fn compared(
  chat_id: i64,
  candidates: usize,
  before: (bool, &[&str], Option<i64>),
  after: After,
) -> Compared {
  Compared {
    chat_id,
    candidates,
    before: Before {
      read: before.0,
      slugs: slugs(before.1),
      ms: before.2,
    },
    after,
  }
}

fn after(read: bool, picked: &[&str], ms: i64, gates: usize, unread: usize) -> After {
  After {
    read,
    slugs: slugs(picked),
    ms,
    gates,
    unread,
  }
}

#[test]
fn the_figures_count_both_sides_and_the_shapes_where_both_read() {
  let figures = figures_of(&[
    compared(-7, 10, (true, &["a"], Some(3_000)), after(true, &["a", "b"], 2_000, 3, 0)),
    compared(-7, 20, (true, &[], Some(1_000)), after(true, &[], 1_000, 2, 0)),
    compared(-8, 8, (false, &[], None), after(false, &["c"], 4_000, 2, 1)),
  ]);

  assert_eq!((figures.runs, figures.rooms), (3, 2));
  assert_eq!(
    figures.candidates,
    Counts {
      least: 8,
      middle: 10,
      most: 20
    }
  );
  assert_eq!(
    (figures.before.read, figures.before.none, figures.before.pieces, figures.before.timed),
    (2, 1, 1, 2)
  );
  assert_eq!(
    (
      figures.after.read,
      figures.after.none,
      figures.after.pieces,
      figures.after.unread_gates,
      figures.after.gates
    ),
    (2, 1, 2, 1, 7)
  );
  assert_eq!(
    figures.shapes,
    Shapes {
      equal: 1,
      superset: 1,
      ..Shapes::default()
    }
  );
  assert_eq!(
    figures.wanting,
    Wanting {
      runs: 1,
      shapes: Shapes {
        superset: 1,
        ..Shapes::default()
      }
    }
  );
  assert_eq!(
    figures.before.ms,
    Some(Spread {
      middle: 3_000,
      ninth: 3_000
    })
  );
  assert_eq!(
    figures.after.ms,
    Spread {
      middle: 2_000,
      ninth: 4_000
    }
  );
}

#[tokio::test]
async fn stored_runs_are_cut_by_today_s_gates_and_put_to_them_again() {
  let ground = road_ground("compare", picking(&["deploy-notes"])).await;

  furnish(&ground);
  ground
    .scratch
    .run(
      r#"INSERT INTO judgements (chat_id, stage, verdict, created_at, ms) VALUES (7, 'classifier', 'deploy-notes', 1002, 2500)"#,
      vec![],
    )
    .await
    .unwrap();

  let prompt = |index: &str| format!("INDEX:\n{index}\n\nMESSAGES:\nOwner (id 5): how do deploys go?");
  let runs = vec![
    StoredRun {
      chat_id: 7,
      ended_at: 1_000,
      prompt: prompt("- deploy-notes \u{2014} how a deploy goes\n- kittens \u{2014} the office cat"),
      answer: "deploy-notes".into(),
    },
    StoredRun {
      chat_id: 7,
      ended_at: 2_000,
      prompt: prompt("- gone \u{2014} no longer offered"),
      answer: "none".into(),
    },
    StoredRun {
      chat_id: 7,
      ended_at: 3_000,
      prompt: "of another shape".into(),
      answer: "none".into(),
    },
  ];
  let out = crate::folder("compare-out").join("figures.json");
  let lines = compare(&ground.reference, &runs, 8, false, Some(&out)).await.unwrap();
  let written: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();

  assert_eq!(lines[0], "sample of 1 \u{b7} 1 rooms \u{b7} 2~2 candidates (median 2)");
  assert_eq!(lines[1], "of 3 runs sifted, 1 not of the shape, 1 dropped as uncuttable, 1 left");
  assert_eq!(lines[2], "pieces attached: before 1.00/turn \u{b7} after 1.00/turn");
  assert!(lines[5].starts_with("how the sets relate: equal 1 \u{b7} superset 0"), "{lines:?}");
  assert!(
    lines[7].starts_with("front stage time: before median 2500ms/90% 2500ms (1 paired)"),
    "{lines:?}"
  );
  assert_eq!(written["corpus"], json!({ "runs": 3, "unreadable": 1, "dropped": 1, "cut": 1 }));
  assert_eq!(written["figures"]["after"]["gates"], 1);
}
