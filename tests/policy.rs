//! The gate's policy: every part reads as its type, no gate stands in the order, and each line names the marks it
//! is filled with.

use std::collections::BTreeSet;

use gate_policy::fill_marks;
use gate_policy::gates::GATE_ORDER;
use gate_policy::memories::MEMORIES;
use gate_policy::profiles::PROFILES;
use gate_policy::reference::REFERENCE;
use gate_policy::translation::TRANSLATION;

#[test]
fn no_gate_stands_in_the_order() {
  assert!(GATE_ORDER.keys().is_empty());
  assert!(GATE_ORDER.standing().is_empty());
  for key in ["output-format", "session-summary", "translator", "sanitizer"] {
    assert!(!GATE_ORDER.holds(key), "{key}");
  }
}

#[test]
fn no_gate_has_a_profile() {
  assert!(PROFILES.profile.is_empty());
  assert!(PROFILES.of("output-format").is_none());
  assert!(PROFILES.of("session-summary").is_none());
}

#[test]
fn the_reference_and_translation_parts_read() {
  assert!(
    REFERENCE.due > 0 && REFERENCE.sheet_lines > 0 && REFERENCE.sheet_chars < REFERENCE.turn_budget_chars
  );

  for mark in ["{id}", "{type}", "{written}", "{moved}", "{for}", "{from}", "{action}"] {
    assert!(MEMORIES.entry.line.contains(mark), "{mark}");
  }

  assert_ne!(TRANSLATION.worker_language, TRANSLATION.owner_language);

  for language in [&TRANSLATION.worker_language, &TRANSLATION.owner_language] {
    assert!(
      TRANSLATION.language_name(language).is_some(),
      "{language} has no name the translator is asked for it by"
    );
  }

  assert_eq!(TRANSLATION.language_name("xx"), None);
}

#[test]
fn marks_are_filled_at_once_and_an_unnamed_one_stays() {
  assert_eq!(fill_marks("<{tag}>", &[("tag", "b")]), "<b>");
  assert_eq!(fill_marks("{a} {b} {c}", &[("a", "{b}"), ("b", "2")]), "{b} 2 {c}");
  assert_eq!(fill_marks("{ x} {", &[("x", "y")]), "{ x} {");
}

#[test]
fn no_old_shared_names_stand_in_the_policy() {
  let names: BTreeSet<&str> = PROFILES.profile.iter().map(|one| one.key.as_str()).collect();

  assert!(names.is_empty());
}
