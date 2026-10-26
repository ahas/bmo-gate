//! The gate a trial may put a question to, asked with its own instructions and thinking, and a stage that is not it
//! refused with the one that is.

use gate_policy::prompts;
use gate_runs::tried::{OUTPUT_GATE, gates, request};

#[test]
fn the_output_gate_alone_may_be_tried() {
  let tried = gates();
  let stages: Vec<&str> = tried.iter().map(|gate| gate.stage.as_str()).collect();

  assert_eq!(stages, [OUTPUT_GATE]);
  assert!(tried.iter().all(|gate| gate.system.is_some() && gate.thinks));
}

#[test]
fn a_trial_asks_the_gate_as_it_asks_itself_and_names_the_stages_it_may_try() {
  let asked = request(OUTPUT_GATE, "a question").unwrap().unwrap();

  assert_eq!(asked.prompt, "a question");
  assert_eq!(Some(asked.system.as_str()), prompts::read("output-gate/telegram-html/format.md"));
  assert!(asked.thinking);
  let Err(stages) = request("translator", "x") else {
    panic!("the translator is no gate a trial tries")
  };

  assert_eq!(stages, [OUTPUT_GATE]);
}
