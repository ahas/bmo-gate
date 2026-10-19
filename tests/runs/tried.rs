//! The gates a trial may put a question to, each asked with its own instructions and thinking, and a stage that
//! is none of them refused with the ones that are.

use gate_policy::prompts;
use gate_runs::tried::{OUTPUT_GATE, gates, request};

#[test]
fn the_output_gate_the_reference_gates_and_the_matcher_may_be_tried_in_the_gate_order() {
  let tried = gates();
  let stages: Vec<&str> = tried.iter().map(|gate| gate.stage.as_str()).collect();

  assert_eq!(
    stages,
    [OUTPUT_GATE, "system-documents", "room-rules", "library-knowledge", "situation-rules"]
  );
  assert!(tried.iter().all(|gate| gate.system.is_some()));
  assert!(tried[0].thinks && tried[1..].iter().all(|gate| !gate.thinks));
}

#[test]
fn a_trial_asks_the_gate_as_it_asks_itself_and_names_the_stages_it_may_try() {
  let asked = request("room-rules", "a question").unwrap().unwrap();

  assert_eq!(asked.prompt, "a question");
  assert_eq!(Some(asked.system.as_str()), prompts::instructions("room-rules"));
  assert!(!asked.thinking);
  let Err(stages) = request("translator", "x") else {
    panic!("the translator is no gate a trial tries")
  };

  assert_eq!(stages.len(), 5);
}
