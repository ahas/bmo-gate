//! The gates the console's trial puts a question to (`docs/boundary-api.md`, `POST /trials`): the output gate of
//! each folding dialect, the three reference gates and the situation-rule matcher, in the gate order. Each is
//! asked exactly as it asks itself — its own instructions, its own road and its own thinking — with the
//! console's text as the material of the call, and nothing is recorded: the answer is about no message.

use gate_policy::gates::GATE_ORDER;
use gate_policy::prompts;

use crate::GateRequest;

/// The output gate, which folds a reply in a dialect that folds, and the instructions it reads for each.
pub const OUTPUT_GATE: &str = "output-format";
pub const OUTPUT_DIALECTS: [&str; 1] = ["output-gate/telegram-html/format.md"];

/// The situation-rule matcher.
pub const SITUATION: &str = "situation-rules";

/// Whether the gates that pick from an index think: picking slugs out of an index needs none.
pub const PICKERS_THINK: bool = false;

/// One gate as the console tries it: its key, its instructions or none where they could not be read, and
/// whether it thinks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tried {
  pub stage: String,
  pub system: Option<&'static str>,
  pub thinks: bool,
}

/// Every gate the console may try, in the gate order.
pub fn gates() -> Vec<Tried> {
  let dialects = OUTPUT_DIALECTS.iter().map(|path| Tried {
    stage: OUTPUT_GATE.to_owned(),
    system: prompts::read(path),
    thinks: GateRequest::new("", "").thinking,
  });
  let pickers = GATE_ORDER.reference_gates().into_iter().chain([SITUATION]).map(|stage| Tried {
    stage: stage.to_owned(),
    system: prompts::instructions(stage),
    thinks: PICKERS_THINK,
  });

  dialects.chain(pickers).collect()
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
