//! The gate's policy: every part reads as its type, the gate order and the profiles name the same gates, each
//! probing gate has its Laya question, and each line names the marks it is filled with.

use std::collections::BTreeSet;

use gate_policy::document_seek::DOCUMENT_SEEK;
use gate_policy::fill_marks;
use gate_policy::gate_pool::GATE_POOL;
use gate_policy::gates::{GATE_ORDER, Part};
use gate_policy::handover::HANDOVER;
use gate_policy::laya::QUESTIONS;
use gate_policy::memories::MEMORIES;
use gate_policy::output_gate::OUTPUT_GATE;
use gate_policy::profiles::PROFILES;
use gate_policy::reference::REFERENCE;

#[test]
fn the_gate_order_reads_every_gate_once_where_it_first_stands() {
  assert_eq!(
    GATE_ORDER.keys(),
    [
      "session-summary",
      "system-documents",
      "room-rules",
      "library-knowledge",
      "people-search",
      "situation-rules",
      "sanitizer",
      "output-format",
      "document-seek",
      "translator",
      "voice-polish",
      "voice-reading",
    ]
  );
  assert_eq!(GATE_ORDER.reference_gates(), ["system-documents", "room-rules", "library-knowledge"]);
}

#[test]
fn a_gate_standing_in_two_parts_is_listed_at_each() {
  let sanitizer: Vec<(Part, usize)> = GATE_ORDER
    .standing()
    .into_iter()
    .filter(|one| one.key == "sanitizer")
    .map(|one| (one.part, one.step))
    .collect();

  assert_eq!(sanitizer, [(Part::Pre, 2), (Part::Post, 0)]);
  assert!(GATE_ORDER.holds("translator") && !GATE_ORDER.holds("content-judge"));
}

#[test]
fn every_gate_of_the_order_has_one_profile_and_nothing_else_has_one() {
  let gates: BTreeSet<&str> = GATE_ORDER.keys().into_iter().collect();
  let profiled: Vec<&str> = PROFILES.profile.iter().map(|one| one.key.as_str()).collect();
  let unique: BTreeSet<&str> = profiled.iter().copied().collect();

  assert_eq!(unique.len(), profiled.len(), "a gate has two profiles");
  assert_eq!(unique, gates);
}

#[test]
fn a_profile_bounds_its_pool_and_names_its_probe() {
  let translator = PROFILES.of("translator").unwrap();
  let room_rules = PROFILES.of("room-rules").unwrap();

  assert_eq!(translator.pool_bound(), 4);
  assert_eq!(room_rules.pool_bound(), GATE_POOL.size);
  assert!(room_rules.laya_probe() && !translator.laya_probe());
  assert!(
    PROFILES
      .profile
      .iter()
      .filter(|one| one.switchable)
      .all(|one| one.key == "voice-polish")
  );
}

#[test]
fn every_gate_laya_asks_of_its_candidates_has_its_question() {
  let mut asked: Vec<&str> = REFERENCE.gates.iter().map(|gate| gate.stage.as_str()).collect();

  asked.push(&REFERENCE.people.stage);

  for stage in &asked {
    let question = QUESTIONS.of(stage).unwrap_or_else(|| panic!("{stage} has no Laya question"));

    assert!(!question.question.is_empty() && !question.subject.is_empty(), "{stage}");
  }

  assert_eq!(QUESTIONS.gates.len(), asked.len(), "a question stands for no gate");
  assert!(QUESTIONS.situation.about.contains("{slug}") && QUESTIONS.situation.about.contains("{rule}"));
  assert!(!QUESTIONS.fold.is_empty());
}

#[test]
fn the_reference_gates_are_the_ones_the_order_marks() {
  let stages: Vec<&str> = REFERENCE.gates.iter().map(|gate| gate.stage.as_str()).collect();

  assert_eq!(stages, GATE_ORDER.reference_gates());
  assert!(GATE_ORDER.holds(&REFERENCE.people.stage));
  assert!(REFERENCE.gate("room-rules").is_some_and(|gate| gate.reads_answered));
  assert!(DOCUMENT_SEEK.cap > 0 && REFERENCE.people.cap > 0);
}

#[test]
fn each_line_names_the_marks_it_is_filled_with() {
  let faults = &OUTPUT_GATE.faults;

  assert!(faults.unescaped.contains("{character}"));
  assert!(
    [&faults.unsupported, &faults.unclosed, &faults.unopened, &faults.nested]
      .iter()
      .all(|line| line.contains("{tag}"))
  );
  assert!(faults.crossed.contains("{open}") && faults.crossed.contains("{tag}"));
  assert!(faults.nested.contains("{inside}"));
  assert!(
    OUTPUT_GATE.decided.by_fallback.contains("{failure}")
      && OUTPUT_GATE.decided.by_fallback.contains("{answer}")
  );

  for line in [
    &REFERENCE.decided.by_fallback,
    &REFERENCE.decided.nothing_attached,
    &REFERENCE.situation.nothing_matched,
  ] {
    assert!(line.contains("{failure}"), "{line}");
  }

  assert_eq!(REFERENCE.decided.no_candidates, "SKIP: no candidates");

  let verdicts = &REFERENCE.verdicts;

  for keyword in [
    &verdicts.picked,
    &verdicts.matched,
    &verdicts.nothing,
    &verdicts.unreadable,
    &verdicts.no_answer,
  ] {
    assert!(
      !keyword.is_empty() && keyword.chars().all(|c| c.is_ascii_uppercase() || c == '-'),
      "{keyword}"
    );
  }

  for mark in ["{id}", "{type}", "{written}", "{moved}", "{for}", "{from}", "{action}"] {
    assert!(MEMORIES.entry.line.contains(mark), "{mark}");
  }
}

#[test]
fn the_summariser_reads_two_conversation_blocks_under_a_heading() {
  assert_eq!(HANDOVER.conversation.len(), 2);
  assert!(HANDOVER.summary_heading.ends_with(':'));
}

#[test]
fn the_summarisers_instructions_name_the_room_as_the_transcript_does() {
  let chat = include_str!("../prompts/session-summary/chat.md");

  assert!(chat.contains(&format!("`{}:`", HANDOVER.room_speaker)));
}

#[test]
fn marks_are_filled_at_once_and_an_unnamed_one_stays() {
  assert_eq!(fill_marks("<{tag}>", &[("tag", "b")]), "<b>");
  assert_eq!(fill_marks("{a} {b} {c}", &[("a", "{b}"), ("b", "2")]), "{b} 2 {c}");
  assert_eq!(fill_marks("{ x} {", &[("x", "y")]), "{ x} {");
}

#[test]
fn every_instruction_file_under_the_prompts_is_compiled_in_and_marks_fill() {
  use gate_policy::prompts::{FILES, instructions, read, render};

  let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("prompts");
  let mut found = vec![];
  let mut folders = vec![root.clone()];

  while let Some(folder) = folders.pop() {
    for entry in std::fs::read_dir(&folder).unwrap().flatten() {
      let path = entry.path();

      if path.is_dir() {
        folders.push(path);
      } else if path.extension().is_some_and(|extension| extension == "md") {
        found.push(path.strip_prefix(&root).unwrap().to_string_lossy().into_owned());
      }
    }
  }

  found.sort();

  let listed: Vec<&str> = FILES.iter().map(|(path, _)| *path).collect();

  assert_eq!(found, listed);
  assert!(instructions("sanitizer").is_some_and(|text| text == text.trim()));
  assert_eq!(read("no-such/file.md"), None);
  assert_eq!(render("{{a}} {{b}} {{ c}} {{", &[("a", "{{b}}"), ("b", "2")]), "{{b}} 2 {{ c}} {{");
}

#[test]
fn every_gate_names_its_tier() {
  assert!(PROFILES.profile.iter().all(|one| !one.tier.is_empty()));
  assert_eq!(PROFILES.of("translator").map(|one| one.tier.as_str()), Some("Reliable"));
}
