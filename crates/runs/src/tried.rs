//! The gates a trial puts a question to (`docs/boundary-api.md`, `POST /trials`): the output gate of each folding
//! dialect. It is asked exactly as it asks itself — its own instructions, its own road and its own thinking — with
//! the trial's text as the material of the call, and nothing is recorded: the answer is about no message.

use gate_policy::prompts;

use crate::GateRequest;

/// The output gate, which folds a reply in a dialect that folds, and the instructions it reads for each.
pub const OUTPUT_GATE: &str = "output-format";
pub const OUTPUT_DIALECTS: [&str; 1] = ["output-gate/telegram-html/format.md"];

/// One gate as a trial tries it: its key, its instructions or none where they could not be read, and
/// whether it thinks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tried {
  pub stage: String,
  pub system: Option<&'static str>,
  pub thinks: bool,
}

/// Every gate a trial may try, in the gate order.
pub fn gates() -> Vec<Tried> {
  OUTPUT_DIALECTS
    .iter()
    .map(|path| Tried {
      stage: OUTPUT_GATE.to_owned(),
      system: prompts::read(path),
      thinks: GateRequest::new("", "").thinking,
    })
    .collect()
}

/// What trying `stage` with `prompt` asks it, or none where its instructions could not be read; the stages that
/// may be tried where it is none of them.
pub fn request(stage: &str, prompt: &str) -> Result<Option<GateRequest>, Vec<String>> {
  let gates = gates();
  let Some(gate) = gates.iter().find(|gate| gate.stage == stage) else {
    return Err(gates.into_iter().map(|gate| gate.stage).collect());
  };

  Ok(gate.system.map(|system| {
    let mut asked = GateRequest::new(system, prompt);

    asked.thinking = gate.thinks;
    asked
  }))
}
