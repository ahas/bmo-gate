//! What the attachments watch raises a row with (`docs/reference-selection.md`, 「Watching what attaches」): the
//! row's title, and its judgement — the shares, where the fault usually lies, and what its job does.

/// The row's title: `{stage}` the gate, `{slug}` the piece.
pub const TITLE: &str = "Fix a reference piece that attaches too often: {stage} {slug}";

/// The judgement's lines. The first is filled with the gate and the piece, both shares and the line.
pub const SHARES: &str = "The {stage} reference gate attached {slug} on {attached} of {asked} turns ({share}) over the last day, and on {recent_attached} of {recent_asked} turns ({recent_share}) over its latest half. The line is {line}.";
pub const CAUSE: &str = "A piece that attaches this often is usually hung on words nearly every turn carries, the names people are called by among them, rather than on what the index line is and when it is needed; or its keywords are such words; or the gate's judgement leans towards it.";
pub const STEPS: [&str; 3] = [
  "1. Read the turns it attached on in the verdict record and in Laya's inputs, and tell whether the index line and its keywords or the gate's judgement is at fault.",
  "2. Fix the cause. For an index line, rewrite it as what the piece is and when it is needed, and bring the rules of the writer that writes that line into line so it does not undo the fix.",
  "3. Ask the last day's inputs again, and report the attach rate before and after the fix.",
];
