//! What the reference nouns print (docs/reference-selection.md, 「What it picks and what it costs, measured」
//! and 「Replaying a stored turn's inputs」): each noun's usage, and what `reference compare` says of its corpus
//! and its figures.

pub const USAGE_COMPARE: &str = "\
usage: bmo reference compare [--per-cell <n>] [--db <address>] [--route-db <address>] [--json] [--out <path>]

Samples stored runs of the reference classifier and puts the same conversation again to the three gates it
was split into, setting before against after: the pieces attached, how the two answers' sets relate, how
often nothing was picked, the share of answers that did not read, and the time the front stage took. The
time is the wall clock of the three gates run side by side.
--per-cell is how many to sample for each room and band of candidate counts (8 by default).
Without --db it reads the gate's database its settings name.
--route-db is the database the gates' roads are read from (the --db one by default).
--json prints the figures as JSON, and --out <path> writes that JSON to a file: a gate's line naming its road
comes out of the same exit, so an answer a machine reads is surer taken from the file.";

pub const USAGE_INPUTS: &str = "\
usage: bmo reference inputs [--db <address>] < turns.jsonl > inputs.jsonl

Takes one turn a line of the standard input ({\"chatId\": <room>, \"messageIds\": [<message>...], \"instructions\":
\"<quiet instruction>\", \"bodies\": {\"<gate>\": [\"<slug>\"]}}) and prints, one JSON line each, the Laya input each
gate is handed with today's piece table and narrowing (the state and a question for each candidate) and each
candidate's index description. instructions is given exactly as written in that turn's quiet instruction
block, and what was read is handed back as it was. A turn with an instruction and no person's words asks
only the gates that declare they are asked so.
A line may carry work ({\"kind\": \"job\", \"title\", \"instruction\", \"requester\", \"requesterId\"} or {\"kind\":
\"search\", \"query\"}) in place of messageIds: it is answered with the knowledge gate's input alone, its lines
and narrowing those of the work's own run.
The pieces named in bodies carry their index description and their body as pieces.
It asks no model and writes nothing. Without --db it opens the gate's database its settings name.";

pub const USAGE_NARROWING: &str = "\
usage: bmo reference narrowing [--db <address>] [--chat <room>] [--turns <n>] [--json]

Narrows the turns an agent actually answered (messages a reference judgement is left on) again with today's
piece table, and measures for each room how many are left for each gate. Without --chat it reads every room a
judgement is left in, and without --turns the latest 20 turns of each.
Without --db it opens the gate's database its settings name. --json prints each turn's figures as JSON.";

pub const USAGE_REPLAY: &str = "\
usage: bmo reference replay [--db <address>] [--use <turns.jsonl>] [--turns <n>] [--out <path>]

Puts real turns with a use judgement through today's reference road again, and sets beside what was recorded
then how many documents each gate attached and how many of them the answer actually used. The gates are
really asked, on the roads the --db database sets.
--turns is how many turns to sample evenly (60 by default), and --out the file each turn's result is written
to as JSON.";

pub const USAGE_ROADS: &str = "\
usage: bmo reference roads [--db <address>] [--json]

Sets, for each room, whether the road reading the piece table and the road reading the index file offer the
same candidates in the same order.
Without --db it opens the gate's database its settings name. --json prints the figures as JSON.";

pub const USAGE_WASTE: &str = "\
usage: bmo reference waste [--db <address>] [--use <turns.jsonl>] [--since <YYYY-MM-DD>] [--top <n>] [--json]

Tables, for every document a reference gate attached, the turns it was attached on, how many of the turns with
a use judgement the answer actually used, the share attached in vain, and the tokens it brought in vain. It also
gives the time spent in the gate stage, and the share of a turn's input the documents attached in vain added.
Without --use it reads the judgements in reference-use/use-1/turns.jsonl of the data folder.";

/// A --per-cell that is no whole number of one or more.
pub const COMPARE_PER_CELL: &str = "reference-compare: --per-cell is a whole number of 1 or more.";
/// What the corpus came to before the gates are asked: the `{runs}` read, the `{unreadable}` of another shape,
/// the `{dropped}` that could not be cut, and the `{sample}` taken out of the `{cut}` left.
pub const COMPARE_CORPUS: &str = "reference-compare: of {runs} runs, {unreadable} are not of the shape and {dropped} could not be cut, so {sample} were sampled out of {cut}.";
/// One sampled turn asked: the `{at}`th of `{sample}`, its `{chat}`, the `{gates}` asked and the `{ms}` taken.
pub const COMPARE_ASKED: &str = "  {at}/{sample} · {chat} · {gates} gates · {ms}ms";
/// The figures written to the file `{out}` names.
pub const COMPARE_WRITTEN: &str = "reference-compare: wrote {out}.";
/// The figures as lines.
pub const COMPARE_SAMPLE: &str =
  "sample of {runs} · {rooms} rooms · {least}~{most} candidates (median {middle})";
pub const COMPARE_SIFTED: &str =
  "of {runs} runs sifted, {unreadable} not of the shape, {dropped} dropped as uncuttable, {cut} left";
pub const COMPARE_PIECES: &str = "pieces attached: before {before}/turn · after {after}/turn";
pub const COMPARE_NONE: &str = "picked nothing: before {before} · after {after}";
pub const COMPARE_UNREAD: &str = "answer did not read: before {before} · after gates {after}";
pub const COMPARE_SHAPES: &str = "how the sets relate: {shapes}";
pub const COMPARE_WANTING: &str = "  turns either side picked on ({runs}): {shapes}";
pub const COMPARE_FRONT: &str = "front stage time: before median {before_middle}ms/90% {before_ninth}ms ({timed} paired) · after median {after_middle}ms/90% {after_ninth}ms";
