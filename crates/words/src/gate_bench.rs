//! What `gate bench` prints (docs/output-gate.md, 「The replay bench」): its usage, its refusals, a pinned set, one
//! call, and the summary of a run.

/// The whole usage, printed for `--help` alone.
pub const USAGE: &str = "\
usage: bmo gate bench <make-set|run|summary> [options]

Replays the chat agent's own answers through the output gate's road, one call at a time, so a change to the
gate or its road is measured on the same pinned set before and after. Its files are in gate-bench/ under the
data root.

  make-set  pins the chat agent's latest answers: --owner-answers <n> in the owner's room (30) and
            --room-answers <n> in group rooms (20).
  run       asks the gate about every part of the set that can be folded, on --registration <name>,
            under --label <name>. --share-ms <ms|profile> is each call's wait (45000); --answer-tokens
            <n[,n]> the answer's ceiling, two of them asking every call at each in turn (4096);
            --offset <n> and --limit <n> take a stretch of the set.
  summary   sums up the run recorded under --label <name>, and writes it beside the run.";

/// The command is missing or none of the three.
pub const COMMAND: &str = "Give one command: make-set, run or summary.";
/// A flag the command needs is missing, `{flag}` the flag.
pub const NEEDS: &str = "{command} needs {flag}.";
/// A wait that is neither a number nor `profile`.
pub const SHARE: &str = "--share-ms is a number of milliseconds or profile, not {share}.";
/// A ceiling that is no number.
pub const CEILING: &str = "--answer-tokens is one or two numbers joined by a comma, not {ceilings}.";
/// The gate's own wait asked for where its options row holds none.
pub const NO_WAIT: &str = "{stage} has no wait of its own in the gate options.";
/// The gate's instructions could not be had.
pub const NO_INSTRUCTIONS: &str = "{stage} has no instructions to run on: {why}";
/// The set or a run is not where it is read from.
pub const NO_SET: &str = "No bench set at {path}; run make-set first.";
pub const NO_RUN: &str = "No run is recorded at {path}.";
/// The answers the set is made from have no route to be read through.
pub const UNAVAILABLE: &str = "The chat agent's answers are unavailable: the receiver serves no route for a room's messages yet, so no set was pinned.";

/// A set pinned, `{owner}` of its answers in the owner's room.
pub const PINNED: &str = "bench set: {answers} answers ({owner} in the owner's room) at {path}";
/// The summary's head, its count line, the table's head, and where it was written.
pub const SUMMARY_TITLE: &str = "# gate bench · {label}";
pub const SUMMARY_COUNTS: &str = "{calls} calls, {items} items, read {at}";
pub const SUMMARY_HEAD: &str = "| stage | ceiling | calls | answered | p50 ms (answered) | p90 ms (answered) | max ms | timeouts | other failures | p90 answer tokens | max answer tokens | cut |";
pub const SUMMARY_RULE: &str = "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
pub const WRITTEN: &str = "written to {path}";
