//! What `gate format-cases` prints (docs/output-gate.md, 「The case collection」): its usage, its answers when
//! there is nothing to show, and one case headed by its room and message, which candidate it was, and then the
//! check's reason, the message and the markup.

/// The whole usage, printed for `--help` alone.
pub const USAGE: &str = "\
usage: bmo gate format-cases [--limit <n>] [--show <id>]

Shows the output gate's format cases, newest first: each markup the structure check refused, why, and the
message it was made for, each cut to its first 1,500 characters. --limit <n> shows that many (20 by
default); --show <id> shows one case whole. It reads the gate's database and writes nothing.";

/// A limit that is no whole number from one.
pub const LIMIT: &str = "--limit is a whole number of 1 or more.";
/// No case stands under the id asked for.
pub const NO_CASE: &str = "No case #{id}.";
/// Nothing has been recorded yet.
pub const NONE: &str = "No format cases are recorded.";
/// The head over a page: how many are shown of how many stand.
pub const HEAD: &str = "{shown} of {total} case(s), newest first";

/// The room the case was judged in, `{chat}` its number, or none where the send path judged before a room.
pub const ROOM: &str = "room {chat}";
pub const NO_ROOM: &str = "no room";
/// The message the case was judged for, `{message}` its number, or none where it did not exist yet.
pub const MESSAGE: &str = "message {message}";
pub const NO_MESSAGE: &str = "no message";
/// Which candidate failed: the markup the code built and had checked once, or the `{attempt}`th the gate made.
pub const CODE_MADE: &str = "the markup the code made, checked once";
pub const ATTEMPT: &str = "attempt {attempt}";
/// Why the structure check refused it, `{reason}` the check's own words.
pub const REASON: &str = "reason: {reason}";
/// The heads over the message the gate read and the markup it made.
pub const TEXT: &str = "the message:";
pub const MARKUP: &str = "the markup the gate made:";
