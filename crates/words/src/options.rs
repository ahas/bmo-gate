//! The sentences a change to a gate's options is refused with, each beside the code it goes out under
//! (docs/codes.md).

/// `no_gate`: `{key}` is no gate of the gate order.
pub const NOT_GATE: &str = "Not a gate: {key}";
/// `own_llm`: thinking and the answer size are the gate's tier's.
pub const OWN_LLM: &str = "A gate's thinking and answer size are set by its tier's own LLM settings.";
/// `nothing_to_change`: the change names no field.
pub const NOTHING: &str = "Nothing to change: send the wait or the switch.";
/// `switch_not_boolean`.
pub const SWITCH: &str = "The switch is true or false.";
/// `always_on`: `{key}` may not be switched off.
pub const ALWAYS_ON: &str = "This gate cannot be switched off: {key}";
/// `timeout_out_of_range`: `{least}` and `{most}` in seconds.
pub const TIMEOUT: &str = "The wait is between {least} and {most} seconds.";
