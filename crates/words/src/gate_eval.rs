//! What `gate eval` prints (docs/gate-eval.md): its usage, its refusals, the generation's start, and the two
//! tables, how far each gate's set has come and the last score of each gate on each road.

/// The whole usage, printed for `--help` alone.
pub const USAGE: &str = "\
usage: bmo gate eval <start|generate|status|score|report> [options]

Makes each gate's evaluation questions with their answer keys on Codex, and scores each gate on each road
with them.

  start     starts the generation as the user unit bmo-gate-eval, run by the binary that ran this command.
  generate  runs the same generation in the foreground. The unit runs this.
  status    shows for each gate how many were made, asked, refused and dropped, what is left, and its state.
  score     asks each gate on --road claude|registered [--registration <name>] and scores it. --limit <n>
            takes only that many for each gate, spread evenly over its whole set.
  report    shows the last score of each gate on each road side by side.

  --set <name>      the set's name (v1 by default). Its data is in gate-eval/<name>/ under the data root.
  --gate <gate>     that gate alone. It may be given more than once.
  --per-gate <n>    how many questions to make for each gate (by default, the number each gate names).
  --batch <n>       how many questions to ask for in one batch (by default, the number each gate names).";

/// No command, or another.
pub const COMMAND: &str = "Give one command: start, generate, status, score or report.";
pub const UNKNOWN_COMMAND: &str = "Unknown command: {command}";
/// A count that is no whole number from one.
pub const COUNT: &str = "{flag} is a whole number of 1 or more.";
/// A gate the set has none of: `{unknown}` those asked, `{known}` those it has.
pub const GATE: &str = "Not a gate of the evaluation set: {unknown} (it has: {known})";
/// A road that is none of `{roads}`, joined by the line after it.
pub const ROAD: &str = "--road is {roads}.";
pub const ROADS_JOINED: &str = " or ";
/// The generation's unit is running already.
pub const RUNNING: &str = "{unit} is running already. See journalctl --user -u {unit}.";

/// The generation started as its unit (`{tree}` the folder it runs in).
pub const STARTED: &str =
  "Started {unit} ({tree}). Progress: bmo gate eval status --set {set} · log: journalctl --user -u {unit}";

/// How far each gate's set has come: the set and its folder, the table's head, and the lines of the gates with no
/// member.
pub const STATUS_SET: &str = "set {set} · {folder}";
pub const STATUS_HEAD: &str =
  "gate | state | made | target | left | batch | asked | refused | dropped | reason";
pub const STATUS_SANITIZER: &str = "sanitizer | not made on Codex | its questions are the harmful sentences themselves, so they are left to the registered model";
/// The voice gates' own line: their members wait for the voice unit's reading of a line's script.
pub const STATUS_VOICE: &str = "voice-polish, voice-reading | no member | their items are read through the voice runner's script, which the voice unit does not serve yet";

/// The last score of each gate on each road: a set with none, and the table's head.
pub const REPORT_NONE: &str = "Set {set} has no scores yet.";
pub const REPORT_HEAD: &str = "gate | road | model | questions | answered | passed | share right | easy | edge | checks met | median s | 90% s";
