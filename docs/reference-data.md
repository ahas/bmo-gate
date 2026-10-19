# The reference gates' data

The four reference gates — `system-documents`, `room-rules`, `library-knowledge` and
`people-search` — are trained on whether the answer the chat agent actually sent used, or needed, the pieces a
turn could have carried. This document is the canonical statement of how their data is made: which
turns it is made of, how a row's input is assembled, what the judge is asked and in which words, how
its verdicts are kept, how rows and figures are read off them, and how it is grown when the owner asks.

- **The only things frozen are the judgement and the turns the run log lets go of.** A label says
  whether one turn's answer used or needed one piece, and it is kept for good; so is a turn the chat agent's
  own instructions opened, since the agency's run log holds its words only for a week (「The turns」). A row is
  not kept: every pass assembles every row afresh from the turns, the input the gate's own code builds for
  that turn today, and the labels. When an index line says something new, the gate narrows candidates
  differently, or retires a piece, the next pass's rows say so, and nothing here has to be told.
- **The input is the gate's, byte for byte.** What a gate is handed — the turn's messages as a state, and
  one question per candidate the narrowing kept, in the probe's own words — is built by the gate's code
  and read from it (「The input」). The training tooling never reads the fragment table or the brain itself.
- **A pass reads its turns once, as it starts,** through the conversation source (`docs/gate-data.md`, 「The
  conversation source」), and the gate's code builds the inputs against the same moment, so a turn and its
  input are read together.
- **What the gate is asked and what it answers** is `docs/reference-selection.md`: the narrowing, the
  probes, and the replay of a stored turn's inputs.
- **Every `bun scripts/…` command below** runs in the training tooling's folder, `training/tooling/`.

## The turns

A turn is one run of messages the chat agent answered together, named by its room and the last of those
messages — the key the chat agent's own records name a turn by — or one run the chat agent's own instructions opened with
no message at all, named by the run.

- **A turn run names its own messages.** The chat agent's turn run writes its prompt into the agency's run log: a scope
  line naming the room and every message it answers, the quiet instructions it was handed in their own
  block, which a scope line of an older run carries itself, and a context line
  for every piece that went into its prompt, the piece's slug ending the path it names. A run of that
  kind is a turn with its messages, and its instructions after them, exactly as the gates read them
  and with what attached known.
- **An answered run older than those lines is rebuilt.** Every run of the chat agent's own messages that answers
  something nobody's scope line claims is a turn too: its messages are the run of other people's
  messages ending just before the chat agent spoke, no two of them more than ten minutes apart, which is how
  the gates themselves cut a turn. What attached is taken from the reference record where it says,
  and is otherwise unknown.
- **A message the gates were asked about whose turn run left no scope line** — the run fell over and
  the message was answered with the ones after it — is a turn of its own on the reference record's
  word, rebuilt the same way, since the gates really were asked about it.
- **The reply is the first run of the chat agent's own messages after the turn**, within thirty minutes of it,
  taken whole up to the next message somebody else sends. A turn with no reply inside the bound has
  nothing to judge a piece against and is left out and counted.
- **A turn the chat agent's own instructions opened is a turn.** A scope line naming no message, in a prompt
  carrying instructions — a job's state, a deployment's notice, a document's update notice, a watch's
  note, nobody's words — is a turn named by its run, with those instructions, as the prompt
  carries them, for its lines, and what attached known from its context lines. The gates were asked
  on it as on any turn, so the checkpoints have to have seen it.
- **Its reply is what the run answered**, its own text lines joined, read off the run rather than the
  room: an answer of `<<SKIP>>` sends nothing to the room and is still the answer, and is the reply.
  A run that wrote no text is left out and counted as a turn with no reply.
- **Such a turn is kept once read.** The agency's run log lets go of a run after about a week, and
  nothing else holds the instructions as the turn read them. So each one a pass reads
  is written once to the run's `instruction-turns.jsonl`, and every pass takes those beside the
  run log's own, the run log's reading winning where both stand.
- **A prompt whose scope line names no message and which carries no instruction answers nobody** and
  is no turn.
- **A piece of work the chat agent handed out is a turn too,** since the knowledge gate is asked for a job and a
  search as for a turn (`docs/reference-selection.md`, 「Work beyond a turn」), and a checkpoint
  that only ever saw conversation reads a work's request as nothing it knows:
  - **a job** is a finished item in a room with a report, named `job:<item>`: its words are the
    item's title and request as its requester's, and its reply is the item's report;
  - **a search** is a finished search with its document, named `search:<search>`: its words are its
    question as a line of the chat agent's, and its reply is the document it wrote, read from the data root;
  - **what attached is not known,** so every piece is judged with the two words, and only the
    knowledge gate has rows of it, as only that gate is asked on the live road;
  - **such a turn is read afresh every pass,** since bmo-job keeps the item and bmo-artifact the search for
    good.
- **What the LLM gate picked** is read from the reference record, one row per candidate, where the
  turn has rows there. It is kept for the figures and never shown to the judge.
- **Every turn of every room is a turn**, newest first. The judging is what costs, so how many turns a
  pass judges is bounded (「A round on request」) and the rest wait for the next pass.

## The input

- **The gate builds it.** `bmo-gate reference inputs`, the gate's own unit command in its deploy tree, is
  handed the turns — their room, their messages, and the instructions the turn was handed — and answers,
  for each gate the narrowing leaves something to,
  the Laya request the gate would be asked today: the state as the gates are handed it and one
  question per candidate kept, named by its slug. On a turn of the chat agent's instructions alone that is
  only the gates such a turn asks, narrowed as such a turn narrows them. It answers the index line of
  each candidate beside it, and the body of any piece it is asked for by gate and slug. Nothing is
  asked of a model and nothing is written.
- **It reads the units as they stand.** The command asks the brain and the receiver as the live road does,
  so the narrowing reads the fragment rows as they stand when the pass asks, minutes after the moment its
  turns were read.
- **A turn whose instructions the gate's answer does not repeat back is counted missing**, as a turn whose
  message is gone is: a build of the gate that does not read instructions would answer for a turn with
  no lines at all.
- **A piece of work is asked for by its words** — the item's title, request and requester, or the
  search's question — in place of messages, and the gate answers the knowledge gate's input for it alone,
  built as the work's own run builds it. One whose words the gate's answer does not repeat back is counted
  missing the same way.
- **A gate the narrowing leaves nothing is no row**, the same as on the live road, where it is not
  asked.
- **The inputs are asked for once a pass, for every turn.** A pass takes the gate's answer as it stands at
  that moment; the one after takes it again. Which version of the gate built them is recorded with the pass.

## What leaves the rooms

A row travels to a training node, so the input the gate built is rewritten the way every row of this
project is (`docs/gate-data.md`, 「What leaves the rooms」) before it is written anywhere.

- **Every person who spoke in the room is replaced wherever the input names them**: their display name
  by a stand-in of the same script, and their number by a stand-in number — in the state, in every
  question, and in the question's own name, since a person-book slug carries its owner's number. The
  same person is the same stand-in in every row, fixed by one seed.
- **The chat agent keeps its own name**, as in every row.
- **Keys, addresses and numbers are then replaced by placeholders** in the state and the questions.
- **A slug is kept whole but for its owner's number**, in the question's name and where its words name
  it: the item numbers and dates a writer put in a slug are the slug's words, not an account or a
  phone, and a slug a placeholder broke is a question no gate is ever asked.
- **What the judge reads leaves the same way**: the turn's messages, the reply, every index line and
  every body.

## The judgement

One item per turn, several turns to a batch, holding no thread, on the codex road
(`docs/gate-data.md`, 「The codex road」) — or, while the codex account is shut, on the claude road
with its one login and tier (`docs/gate-data.md`, 「The claude road」).

- **What is judged** is every candidate a turn's rows would carry that has no label yet, and every
  piece the reference record says a gate attached on that turn, whether or not the narrowing offers it
  today — those are what the LLM gates' over-selection is read from.
- **The chat agent's own instructions stand in the item.** An item carries the instructions its turn was
  handed beside its messages, which are empty on a turn the instructions opened, and the judge is
  told that instructions are nobody's words and that a reply of `<<SKIP>>` is the chat agent saying nothing.
- **A piece of work says it is one.** Its item carries the work's kind and its request — the
  search's question as instructions, since it is a line of the chat agent's — and the judge is told that
  such an item is a job or a search the chat agent handed out, whose reply is the job's report or the search's
  document, and that a piece is needed where the work had to rest on what only that piece holds.
- **An attached piece is answered with one of three words.** A piece is attached where the turn run's
  context lines or the reference record say it reached the prompt. Each word's definition stands in the
  judge's instructions in the room language, word for word as the labels were judged by, in the reference
  data's judge data, `prompts/tooling/reference-judge.toml`, and the code's prompt carries them unchanged. In English they say:
  - `used` — the answer actually took up content found only in this document: a fact, a figure, a name,
    a procedure or a rule;
  - `related` — the document touches the answer's subject, but the answer would have been the same
    without it;
  - `unused` — the answer has nothing to do with the document.
- **Any other piece is answered with one of two**, read off its index line alone:
  - `needed` — the answer had to use content only this document would hold (a fact, a figure, a name, a
    procedure or a rule), and was wrong or short for lacking it; touching the document's subject or words
    is not enough;
  - `not-needed` — the answer did not need this document; where the subject touches but the answer was
    right and whole without it, it is this.
- **A turn whose attachments are unknown** has every piece judged with the two words. A piece that
  was in fact attached and used is `needed` by that reading, so the gold it makes is the same.
- **Nothing in the item says which side picked what.** The judge is not told the LLM's yes or Laya's.
- **The bounds of one item.** A reply is cut at 8,000 characters and an attached body at 6,000; a
  batch holds at most eight turns and 60,000 characters of items, always taking one turn however long
  it is.
- **An answer is read per candidate and a gap is not a no.** A candidate left unanswered, or answered
  with a word not offered for its kind, has no label and is asked again on the next pass. A candidate
  is answered under its gate and slug, as the item names it, or under its slug alone where no other
  piece of the item shares that slug, since a judge may drop the gate from a key it was given.
- **A failed batch ends the pass's judging.** Batches go a few at a time; once one of them fails — a
  spent limit, a refusal, an answer from another model — no further batch is started, the ones
  already under way land, and every turn not reached waits for the next pass. A spent limit is met
  once, not once for every batch left.

## Judging a word again

A label judged by wider words than the prompt carries now still stands and still makes gold. A pass
can be told to judge one word again instead of judging what has no label.

- **What is judged again** is every standing label of the named word judged before a named moment,
  on a piece the turn's rows carry or the record says attached — the same pieces an ordinary pass
  would ask about. A label on a piece the narrowing no longer offers keeps its word, since no row
  reads it.
- **Only those pieces are in the items**, judged with the words the prompt carries now. Pieces with
  no label wait for an ordinary pass.
- **The pass can be held to some gates**, so the gates a comparison rests on are judged first and the
  others after.
- **The new label is appended and wins**, as every label does. Its moment is after the named one, so a
  re-judging pass that stopped — at a spent limit or a failed batch — is taken up by running it again
  with the same moment, and judges only what it had not reached.
- **A corrected label is never judged again** (「Correcting labels」): it was settled one case at a
  time against the words the prompt carries now, which a pass's judge does not improve on.

## The labels

- **A label is keyed by turn, gate and slug**, and carries its word, whether it was judged as
  attached, where it came from — the number of its judged batch, `imported`, or `corrected` with what
  corrected it — and when. `labels.jsonl` holds them, one a line, only ever appended
  to; the latest line for a key is the one that stands.
- **A label outlives a rewritten index line.** What it says is whether the answer used or needed the
  piece, which a new description of the piece does not change. A candidate the narrowing newly offers
  on a turn has no label and is judged on the next pass; a candidate it no longer offers drops out of
  the row and keeps its label.
- **Labels judged by another run are taken in once,** as `imported` with the key and the word they were
  given, where they are the same judgement in the same words.

## Correcting labels

A judge's word found wrong — on a piece a gate came to attach far too often, read case by case — is
corrected in the run's labels, so the next pass's rows and every training after it carry the corrected
gold instead of teaching the old one again.

- **`bun scripts/reference-correct.ts <run> <corrections.jsonl> --by '<what settled them>'` is the
  one command.** It appends one label per correction and edits no line already there; the latest line
  for a key stands, as for every label. `--dry-run` checks the file and counts each word moving to
  another, writing nothing.
- **A correction names a key already labelled and the word it should carry**: one JSON object a line
  with the turn, the gate, the slug and the word. Whether the piece was attached is the standing
  label's, so the word is one of the words offered for that kind.
- **The whole file lands or none of it does.** A line that does not read, a gate that is not a
  reference gate, a key with no standing label or a word not offered for its kind refuses the file,
  each such line named, and nothing is written.
- **A corrected label carries `corrected` where a judged one carries its batch, and what settled it**
  in its own field — the item and how its verdicts were reached — so it is told apart from the
  judge's own labels and never judged again by a pass (「Judging a word again」).
- **It takes the run's claim as a pass does** and refuses while a pass holds it, since a pass chooses what
  to judge from the labels as it starts, and a label it judged later would stand over the correction.
- **Nothing is judged or trained by it.** The next pass's rows carry the corrections; the training
  over them waits for a round the owner asks for, as every training does.

## The rows

The rows take the shape every row of this repository takes, the one the training reads
(`docs/gate-data.md`, 「A run folder」).

- **One row a turn a gate a Laya call.** A turn's candidates are cut the way the gate's Laya client cuts
  its request: every candidate the narrowing kept, in the gate's order, 128 to a row, each row with the
  turn's same state. A turn of up to 128 candidates is one row; one of 300 is three, of 128, 128
  and 44. No candidate is dropped for being past one call.
- **The state is the gate's state**, rewritten as above. A state longer than one Laya call reads is cut to
  its newest lines that fit, and the cut is counted.
- **The questions are the gate's questions**, rewritten as above, under their slugs.
- **A row names the kind of input it is,** as its `stratum`: `work` for a job or a search, `turn` for
  every other turn. The two are written differently — a work's request as one line, a turn's
  messages after the line they follow on from — and are needed at different rates, so the training
  balances each piece within its kind (`docs/laya-server.md`, 「The training loop and calibration」).
- **The gold of a question** is a yes/no distribution: yes at 0.95 for `used` and `needed`, no at
  0.95 for `unused` and `not-needed`, and an even half for `related`.
- **A row carries the candidates of its call that have a label.** Laya reads each question as a
  sequence of its own — the state and that one question — so a candidate left out changes nothing any
  other question of the row is taught or measured on. A candidate with no label yet is left out and
  counted as unlabelled, and joins the row on the pass its label lands. A call none of whose
  candidates has a label is no row and is counted as waiting. The person book grows new pieces every
  day, each offered on every turn of its owner, so a row held back for its last label would hold back
  nearly every turn of a busy room until each new piece had been judged on all of them.
- **A row's id is its input's hash; its split is its turn's.** The split is drawn from the turn's key
  at fifteen per cent calibration and fifteen per cent test, so a turn stays in its split however its
  input changes, and a test turn is never trained on in a later pass because its description moved.
- **Every row is checked against its gate's specification** (`docs/laya-gates.md`) before it is
  written, and a refused row is counted by its reason.

## The figures

- **The gold of a candidate.** `used` and `needed` are yes; `unused` and `not-needed` are no;
  `related` is contested and stands out of every comparison of sets.
- **The figures are read off the labels**, not off the rows, so they say what the judge found on the
  turns as they were answered and are the same whatever the narrowing does today.
- **Over-selection** of a gate is the share of its attached pieces judged `unused`, with `related`
  counted beside it rather than inside it.
- **Missing** of a gate is the number of turns where some piece it did not attach was judged
  `needed`, and the number of such pieces, beside the turns it was asked on.
- **The LLM gate's own set against the use gold** is read on the turns the reference record holds.
- **Laya is asked again, not read back.** Each turn's input as the gate builds it today is put to the Laya
  service as it serves now, so a score belongs to the checkpoint serving the gate today. A turn of
  more than 128 candidates is asked in the calls the gate's client cuts it into, and a call that fails
  leaves the turn unanswered. An answer is kept beside the checkpoint that gave it and the input it
  was given, and reused while both stand.
- **Laya's verdict on a candidate** is yes at or above even odds, and its confidence the larger of
  its two probabilities. **At each τ**, as the filter settles these gates candidate by candidate
  (`docs/laya-gates.md`, 「Question types」), the figures count candidates: how many reach τ and
  their share of those Laya answered, how many of those matched the use gold among the uncontested
  ones, and the turns where every candidate reached τ — the turns the LLM is not asked at all.
- **The rarer answer is counted before anything is trained.** For each gate: its rows, the rows
  waiting on a label, the questions whose gold is yes, the ones whose gold is no, the contested ones,
  and how many rows hold at least one yes.

## Distilled work labels

The judgement above reads a work's report, so a piece the report never names is judged not needed,
and work has few yes answers to learn from: a job is judged needing a piece about four times in a
thousand. The knowledge gate is asked on work before it runs, so its work labels are also distilled
from a teacher asked the gate's own question.

- **Every piece of work bmo-job and bmo-artifact hold is taught**, not only the finished ones: each item not
  merged into another, by its title, request and requester; each distinct text of a job run with no
  item; and each search's question. A text asked twice in one room is one work. A browse's task is
  deleted from the disk once read, since it may carry a login, so no browse is ever taught.
- **The input is the gate's.** `bmo-gate reference inputs` builds the knowledge gate's input for each work
  as its own run builds it — a job with no item asked as its text on a line of the chat agent's —
  and a work the narrowing leaves no candidate is not taught, as the gate is not asked on it.
- **The teacher reads what the gate decides from, and more.** It is given the work's request and,
  once per batch, every piece the batch's works are offered with its index line and its whole body;
  it is not given the report. For each work and each candidate it answers `needed` or `not-needed`,
  its own probability that the piece is needed, and one sentence saying why.
- **Each work is taught three times, and the gold is the mean.** Each sample is a call of its own
  that sees none of the others; a distilled row's gold for a question is the mean of the three
  probabilities to the hundredth, the way Laya's own benchmark data is made from its teacher
  (`docs/laya-server.md`, 「Laya's own recipe」). A candidate stands in a row only once all three have
  answered it, and how often one sample's word agrees with the mean of the other two is reported as
  the teacher's agreement with itself.
- **The teacher is the claude road** (`docs/gate-data.md`, 「The claude road」): the second Claude
  account, `claude-sonnet-5` at high effort. Works of one room share a batch, six to a batch: a
  call must answer inside the road's ten minutes, and six works keep it well inside.
- **What leaves the rooms leaves the same way:** the request and every body are rewritten with the
  stand-ins every reference pass gives, so one person is one stand-in in both kinds of rows.
- **The rows are reference rows of the kind `work`**, made by the same assembly, split by the work's
  key as every reference row is, so an item a reference pass holds out for the test is held out
  here too.
- **A training on them** takes the reference run's rows, with each piece's work rows in training and
  calibration replaced by the distilled ones, and keeps the reference run's test rows as they are, so
  a checkpoint is measured on what the judge found and the distilled test rows are read beside it.
  It is run with `--kind-ratio work=8`, holding the work rows to their own balance ratio
  (`docs/laya-server.md`, 「The training loop and calibration」), since distilled work is needed far
  more often than judged turns are.
- `bun scripts/work-distill.ts <run>` makes one run, under the data root's `work-distill/`:
  `labels.jsonl` with every sample, its probability and its reason; `taught/<n>-<sample>.json` with
  each call frozen as it lands, the works it carried, the raw answer, the tokens and the teacher;
  `gates/` with the rows; `training/`, the dataset folder a training reads (above), made with the
  reference run `--with` names, `ref-1` by default; `distilled-test.jsonl`; and `report.json`.
- **A run takes up the works still wanting a label,** so a run stopped by a spent limit is run again
  once the limit resets.

## A run and its folder

`bun scripts/reference-data.ts <run>` makes one pass, and a bare run name resolves under the runtime
data root's `reference-data/` folder, never inside this checkout.

- `labels.jsonl` — every label, appended.
- `judged/<n>.json` — each judged batch, frozen the moment its answer lands with the items it
  carried, the labels read out of it, the raw answer, the tokens it spent and the judge that
  answered it: its road, model and effort, and the account where the road rides one.
- `laya.jsonl` — Laya's answers, each with the checkpoint that gave it and the hash of the input.
- `gates/<gate>/` — the gate's rows now, in `train.jsonl`, `calibration.jsonl` and `test.jsonl`, and
  `data.json` with the counts above and a digest of the three files. The whole `gates/` folder is
  written under a partial name and put in place in one rename, so a training pass reading it reads one
  pass's rows and never half of two.
- `instruction-turns.jsonl` — every turn the chat agent's own instructions opened, as it was first read: its
  key, room, moment, instructions, reply and what attached. Only ever appended to.
- `turns.jsonl` — one line per turn: its key, where it was read from, its messages' numbers, whether
  what attached is known, and why it was left out where it was.
- `ticks.jsonl` — one line per pass: when, the gate's version that built the inputs, when the pass read
  its turns, how many turns stood,

  how many were judged, the calls and the tokens they spent, and how many times Laya was asked and
  reused.
- `report.json` — the figures, per gate and per τ.
- `rounds.jsonl` — one line per round (「A round on request」). Only ever appended to.

## A round on request

- **A round runs only when the owner asks for one.** No timer starts it, and neither the pass of the data
  nor the training over it runs on its own.
- **`bun scripts/reference-round.ts`, run in the training tooling's folder of the deployed release, is the one command.** It
  starts the round as a transient user unit, `bmo-gate-reference-round`, and returns at once; the
  unit outlives whoever started it, and `journalctl --user -u bmo-gate-reference-round` is its log.
  It refuses while a round is still going.
- **A round is a pass of the data over the run `ref-1`, then a training pass over its gates**
  (`docs/training.md`) that gives way to other work. A data pass that failed does not stop the
  training pass, which trains on the rows the last good pass put in place.
- **The training runs on the training placement's nodes** (`docs/training.md`, 「The nodes」). A node
  that cannot train when the round starts — a WSL machine with its WSL off, a node gone quiet — drops
  out, and where none is left no training node stands until the owner names one. Which nodes the placement
  names now is the placement's answer (the node unit's documents).
- **With no training node left, the command refuses the round before starting it,** saying which
  nodes dropped out and why, so a round asked for never runs the data pass for a training that has
  nowhere to go.
- **A round waits for the operations machine to be quiet before it starts, and before every gate it hands out.**
  The pass of the data, the judge's calls and the training's driver run on the operations machine beside the
  deployment's jobs and share its memory; a round beside a handful of site-tool jobs fills the swap, and the
  Laya service on the same machine is what the kernel ends first. Quiet is:
  - no job running;
  - no other training — the text model's own training or the judging run's training pass;
  - memory available: twelve gibibytes before the round starts, since the pass of the data holds up
    to about eleven at its peak, and six before each gate, where only the training's driver runs
    here.
- **The wait has no bound.** It reads again every minute and writes a line every ten minutes saying
  what it waits for, since a round is asked for and has no deadline.
- **On the node, the card is the card arbiter's.** A gate in flight gives way to a claimant the rules put
  first, a game on the desktop and the services above it (`docs/training.md`, 「One gate on one node」).

- **`--spare <unit>` names a job or a training the round does not wait for.** A job that starts a
  round and stays to watch it spares itself, the `bmo-task-…` unit its prompt opens with, since a
  round would otherwise wait for the job waiting on it. Sparing anything else is the owner's word for one
  round; the memory floor is never spared.
- **Each round leaves a line in `rounds.jsonl`** in the run's folder: when it was asked, how long it
  waited, how long the data pass and the training pass took and how each ended, and the training
  run's name, whose ledger holds each gate's seconds.
- **One pass at a time over a run.** A pass claims the run before it starts and a second one stands
  down while the first lives, since two would judge the same turns twice and put the gates in place
  under each other. Standing down is not a failure.
- **A pass judges at most sixty turns**, newest first among the turns that have a candidate with no
  label. The backlog of every room's history is drawn down at that pace, which bounds what one pass
  spends on the codex road; a pass with nothing to judge spends no call and still assembles every row.
- **The training holds a reference gate to its rarer answer as well as its rows:** a thousand rows and
  two hundred questions whose gold is yes, since a reference gate's yes answers are a few in a hundred.
  A gate whose rows are mostly the ones its last point was trained on is not trained again
  (`docs/training.md`, 「When a gate is trained」).
- **A backlog is drawn down faster by one pass with a larger bound** —
  `bun scripts/reference-data.ts ref-1 --judge <n>` — followed by a round, or by
  `bun scripts/laya-train.ts reference:ref-1 --give-way`. A frozen batch is never judged again, so a
  pass cut off loses only the batches it had not frozen, and the next pass takes their turns up.
- **A kind of turn new to the data is judged ahead of the backlog** by a pass held to the turns of
  one source — `bun scripts/reference-data.ts ref-1 --source instructions --judge <n>` judges only
  the turns the chat agent's own instructions opened, and `--source work` only the jobs and searches —
  followed by the same training pass.
- **A word is judged again by a pass of its own** (「Judging a word again」) —
  `bun scripts/reference-data.ts ref-1 --rejudge needed --before <moment> --judge <n>`, with
  `--gate <gate>` for each gate it is held to and `--road claude` while codex is shut — followed by
  the same training pass.
- **Verdicts already settled outside a pass go in as corrections** (「Correcting labels」), with no
  judge's call, followed by the same training pass when the owner asks for one.
