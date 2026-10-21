//! What `gate laya-agreement` prints (docs/laya.md, 「Agreement」): its usage, and the table of how often Laya
//! agrees with each gate's LLM.

/// The whole usage, printed for `--help` alone.
pub const USAGE: &str = "\
usage: bmo gate laya-agreement [--stage <gate>] [--db <address>] [--json]

Shows how often Laya agrees with each gate's LLM: the pairs, the failures, the agreement overall, and at
each tau the share Laya would take on (covered) and the agreement within it. A gate that decides each
candidate apart is counted by question rather than by pair, with the share of the questions Laya answered
that it settled in the gate's place (settled by Laya). A gate with a safe verdict adds how often Laya said
safe and the share of those the LLM called safe too.
Without --db it reads the gate's database its settings name. It only reads, and writes nothing.
--json prints each gate's figures as JSON.";

/// No gate has recorded a pair yet.
pub const NONE: &str = "No Laya verdicts are recorded yet.";

/// A gate's opening line: what it is counted over (`{counted}`, one of the two below), its failures, its
/// agreement, and for a gate counted by question the share Laya settled (`{settled}`, the line below or
/// nothing).
pub const GATE: &str = "{stage}: {counted} · failures {failures} · agreement {agreement}{settled}";
pub const QUESTIONS: &str = "questions {count}";
pub const PAIRS: &str = "pairs {count}";
pub const SETTLED: &str = " · settled by Laya {share}";

/// The head of a gate's tau lines, and the two columns a gate with a safe verdict adds to it.
pub const HEAD: &str = "  tau    covered  agreement";
pub const SAFE_HEAD: &str = "     said safe  LLM safe too";
