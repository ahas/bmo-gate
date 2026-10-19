//! The sentences a change to a gate's options is refused with, each beside the code it goes out under
//! (docs/codes.md). A Laya mode is named by its own word: `off`, `shadow`, `filter` or `asymmetric`.

/// `no_gate`: `{key}` is no gate of the gate order.
pub const NOT_GATE: &str = "Not a gate: {key}";
/// `own_llm`: thinking and the answer size are the gate's tier's.
pub const OWN_LLM: &str = "A gate's thinking and answer size are set by its tier's own LLM settings.";
/// `nothing_to_change`: the change names no field.
pub const NOTHING: &str =
  "Nothing to change: send one of the wait, the Laya mode, τ, the switch or the Laya fallback LLM.";
/// `laya_fallback_unknown`: `{fallback}` is the word for no fallback.
pub const FALLBACK: &str = "The Laya fallback LLM is a provider's name or {fallback}.";
/// `switch_not_boolean`.
pub const SWITCH: &str = "The switch is true or false.";
/// `always_on`: `{key}` may not be switched off.
pub const ALWAYS_ON: &str = "This gate cannot be switched off: {key}";
/// `timeout_out_of_range`: `{least}` and `{most}` in seconds.
pub const TIMEOUT: &str = "The wait is between {least} and {most} seconds.";
/// `laya_mode_unknown`: `{modes}` the modes there are.
pub const MODE: &str = "The Laya mode is one of {modes}.";
/// `laya_tau_out_of_range`.
pub const TAU: &str = "τ is a number between 0 and 1.";
/// `laya_mode_refused` with `no_probe`.
pub const NO_QUESTION: &str = "This gate has no Laya question, so it can only be off: {key}";
/// `laya_mode_refused` with `no_safe_verdict`.
pub const NO_SAFETY: &str = "This gate has no safe verdict, so it cannot be asymmetric: {key}";
/// `laya_mode_refused` with `no_checkpoint`.
pub const NO_CHECKPOINT: &str = "The Laya server has no checkpoint for this gate, so it was not put in {mode} mode: the latest health check does not name it: {key}";
/// `laya_mode_refused` with `needs_tau`.
pub const NEEDS_TAU: &str = "The {mode} mode needs a τ.";
