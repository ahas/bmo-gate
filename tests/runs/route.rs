//! The road a gate's role gives a run: its active provider's entry, else the first entry on, else the order's
//! first with nothing to run on, and no road from an empty order; a registered model's thinking and answer room
//! are the entry's.

use gate_runs::options::{answer_room, thinks_on};
use gate_runs::route::road_provider;

use crate::runs::fakes::{entry, provider, role};

#[test]
fn a_run_goes_out_on_the_roles_active_provider_with_its_entry_there() {
  let providers = vec![provider("claude-code", false), provider("registry", true)];
  let order = vec![
    entry("claude-code", "a-model", None, None),
    entry("registry", "a-registration", Some("on"), Some(4096)),
  ];
  let (on, mapping) =
    road_provider("a-gate", &role("a-gate-role", order, Some("registry")), &providers).unwrap();

  assert_eq!(on, "registry");
  assert_eq!(mapping.unwrap().model, "a-registration");
}

#[test]
fn a_role_with_no_active_provider_goes_out_on_the_first_entry_that_is_on() {
  let mut off = provider("claude-code", false);

  off.enabled = false;

  let providers = vec![off, provider("registry", true)];
  let order = vec![
    entry("claude-code", "a-model", None, None),
    entry("registry", "a-registration", None, None),
  ];
  let (on, mapping) = road_provider("a-gate", &role("a-gate-role", order, None), &providers).unwrap();

  assert_eq!(on, "registry");
  assert_eq!(mapping.unwrap().provider, "registry");
}

#[test]
fn an_order_with_no_provider_on_stands_on_its_first_with_nothing_to_run_on() {
  let mut off = provider("claude-code", false);

  off.enabled = false;

  let order = vec![entry("claude-code", "a-model", None, None)];
  let (on, mapping) = road_provider("a-gate", &role("a-gate-role", order, None), &[off]).unwrap();

  assert_eq!(on, "claude-code");
  assert_eq!(mapping, None);
}

#[test]
fn a_role_whose_order_is_empty_gives_a_gate_no_road() {
  let refused =
    road_provider("a-gate", &role("doppelganger", vec![], None), &[provider("claude-code", false)]);

  assert!(refused.unwrap_err().to_string().contains("no provider order of its own"));
}

#[test]
fn a_registered_runs_thinking_and_answer_room_are_its_entrys() {
  let thinking = entry("registry", "a-registration", Some("on"), Some(4096));
  let plain = entry("registry", "a-registration", Some("off"), None);

  assert!(thinks_on(&thinking));
  assert!(!thinks_on(&plain));
  assert_eq!(answer_room("a-gate", Some(&thinking)), 4096);
  assert_eq!(answer_room("a-gate", Some(&plain)), gate_runs::options::DEFAULT_ANSWER_TOKENS);
}
