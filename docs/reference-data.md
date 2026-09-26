# The reference gates' data

The four reference gates — `system-documents`, `room-rules`, `library-knowledge` and
`people-search` — are trained on whether the answer BMO actually sent used, or needed, the pieces a
turn could have carried. This document is the canonical statement of how their data is made: which
turns it is made of, how a row's input is assembled, what the judge is asked and in which words, how
its verdicts are kept, how rows and figures are read off them, and how it grows every hour.

- **The only things frozen are the judgement and the turns the archive lets go of.** A label says
  whether one turn's answer used or needed one piece, and it is kept for good; so is a turn the bot's
  own instructions opened, since the archive holds its words only for a week (「The turns」). A row is
  not kept: every pass assembles every row afresh from the turns, the input BMO's own code builds for
  that turn today, and the labels. When BMO rewrites what an index line says, narrows candidates
  differently, or retires a piece, the next pass's rows say so, and nothing here has to be told.
- **The input is BMO's, byte for byte.** What a gate is handed — the turn's messages as a state, and
  one question per candidate the narrowing kept, in the probe's own words — is built by BMO's code
  and read from it (「The input」). This repository never reads the fragment table or the brain.
- **A pass reads one copy of BMO's archive** and never the live one (`docs/gate-data.md`, 「The
  archive copy」): the turns are read from the copy the pass takes as it starts, and BMO's code builds
  the inputs from that same copy, so a turn and its input are read from the same moment.
- **What BMO is asked and what it answers** is BMO's `docs/reference-selection.md`: the narrowing, the
  probes, and the replay of a stored turn's inputs.

## The turns

A turn is one run of messages BMO answered together, named by its room and the last of those
messages — the key BMO's own records name a turn by — or one run BMO's own instructions opened with
no message at all, named by the run.

- **A turn run names its own messages.** BMO's turn run writes a scope line into the agent log naming
  the room, every message it answers and the quiet instructions it was handed, and a context line
  for every piece that went into its prompt, the piece's slug ending the path it names. A run of that
  kind is a turn with its messages, and its instructions after them, exactly as the gates read them
  and with what attached known.
- **An answered run older than those lines is rebuilt.** Every run of BMO's own messages that answers
  something nobody's scope line claims is a turn too: its messages are the run of other people's
  messages ending just before BMO spoke, no two of them more than ten minutes apart, which is how
  the gates themselves cut a turn. What attached is taken from the reference record where it says,
  and is otherwise unknown.
- **A message the gates were asked about whose turn run left no scope line** — the run fell over and
  the message was answered with the ones after it — is a turn of its own on the reference record's
  word, rebuilt the same way, since the gates really were asked about it.
- **The reply is the first run of BMO's own messages after the turn**, within thirty minutes of it,
  taken whole up to the next message somebody else sends. A turn with no reply inside the bound has
  nothing to judge a piece against and is left out and counted.
- **A turn the bot's own instructions opened is a turn.** A scope line naming no message but
  carrying instructions — a job's state, a deployment's notice, a document's update notice, a watch's
  note, nobody's words — is a turn named by its run, with those instructions, as the scope line
  carries them, for its lines, and what attached known from its context lines. The gates were asked
  on it as on any turn, so the checkpoints have to have seen it.
- **Its reply is what the run answered**, its own text lines joined, read off the run rather than the
  room: an answer of `<<SKIP>>` sends nothing to the room and is still the answer, and is the reply.
  A run that wrote no text is left out and counted as a turn with no reply.
- **Such a turn is kept once read.** The archive's run log lets go of a run after about a week, and
  nothing else in the archive holds the instructions as the turn read them. So each one a pass reads
  is written once to the run's `instruction-turns.jsonl`, and every pass takes those beside the
  archive's own, the archive's reading winning where both stand.
- **A scope line naming neither a message nor an instruction answers nobody** and is no turn.
- **What the LLM gate picked** is read from the reference record, one row per candidate, where the
  turn has rows there. It is kept for the figures and never shown to the judge.
- **Every turn of every room is a turn**, newest first. The judging is what costs, so how many turns a
  pass judges is bounded (「Keeping it growing」) and the rest wait for the next pass.

## The input

- **BMO builds it.** `bun scripts/reference-inputs.ts` in BMO's live checkout is handed the pass's
  archive copy by `--db` and the turns — their room, their messages, and the instructions the turn
  was handed — and answers, for each gate the narrowing leaves something to,
  the Laya request the gate would be asked today: the state as the gates are handed it and one
  question per candidate kept, named by its slug. On a turn of the bot's instructions alone that is
  only the gates such a turn asks, narrowed as such a turn narrows them. It answers the index line of
  each candidate beside it, and the body of any piece it is asked for by gate and slug. Nothing is
  asked of a model and nothing is written.
- **A turn whose instructions BMO's answer does not repeat back is counted missing**, as a turn whose
  message is gone is: a checkout of BMO that does not read instructions would answer for a turn with
  no lines at all.
- **A gate the narrowing leaves nothing is no row**, the same as on the live road, where it is not
  asked.
- **The inputs are asked for once a pass, for every turn.** A pass takes BMO's answer as it stands at
  that moment; the one after takes it again. Which commit of BMO built them is recorded with the pass.

## What leaves the rooms

A row travels to a training node, so the input BMO built is rewritten the way every row of this
repository is (`docs/gate-data.md`, 「What leaves the rooms」) before it is written anywhere.

- **Every person who spoke in the room is replaced wherever the input names them**: their display name
  by a stand-in of the same script, and their number by a stand-in number — in the state, in every
  question, and in the question's own name, since a person-book slug carries its owner's number. The
  same person is the same stand-in in every row, fixed by one seed.
- **BMO keeps its own name**, as in every row.
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
- **The bot's own instructions stand in the item.** An item carries the instructions its turn was
  handed beside its messages, which are empty on a turn the instructions opened, and the judge is
  told that instructions are nobody's words and that a reply of `<<SKIP>>` is the bot saying nothing.
- **An attached piece is answered with one of three words.** A piece is attached where the turn run's
  context lines or the reference record say it reached the prompt. These three lines are the judge's
  instructions word for word, and the code's prompt carries them unchanged:
  - `used` — 답이 이 문서에만 있는 내용(사실, 수치, 이름, 절차, 규칙)을 실제로 가져다 썼다.
  - `related` — 답의 주제와는 맞닿아 있지만, 이 문서가 없었어도 답이 그대로였다.
  - `unused` — 답이 이 문서와 상관이 없다.
- **Any other piece is answered with one of two**, read off its index line alone:
  - `needed` — 답이 이 문서에만 있을 내용(사실, 수치, 이름, 절차, 규칙)을 써야 했는데, 그게 없어서 틀리거나 모자랐다. 답이 이 문서의 주제나 낱말을 건드린 것만으로는 여기에 들지 않는다.
  - `not-needed` — 답에 이 문서가 필요하지 않았다. 주제가 맞닿아 있어도 이 문서 없이 답이 맞고 모자람이 없었다면 여기에 든다.
- **A turn whose attachments are unknown** has every piece judged with the two words. A piece that
  was in fact attached and used is `needed` by that reading, so the gold it makes is the same.
- **Nothing in the item says which side picked what.** The judge is not told the LLM's yes or Laya's.
- **The bounds of one item.** A reply is cut at 8,000 characters and an attached body at 6,000; a
  batch holds at most eight turns and 60,000 characters of items, always taking one turn however long
  it is.
- **An answer is read per candidate and a gap is not a no.** A candidate left unanswered, or answered
  with a word not offered for its kind, has no label and is asked again on the next pass.
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

## The labels

- **A label is keyed by turn, gate and slug**, and carries its word, whether it was judged as
  attached, the batch it came from and when. `labels.jsonl` holds them, one a line, only ever appended
  to; the latest line for a key is the one that stands.
- **A label outlives a rewritten index line.** What it says is whether the answer used or needed the
  piece, which a new description of the piece does not change. A candidate the narrowing newly offers
  on a turn has no label and is judged on the next pass; a candidate it no longer offers drops out of
  the row and keeps its label.
- **The labels judged before this data existed are taken in once**, from the run that judged BMO's
  turns first, as `imported` with the key and the word they were given. They are the same judgement
  in the same words.

## The rows

The rows take the shape every row of this repository takes, the one the training reads
(`docs/gate-data.md`, 「A run folder」).

- **One row a turn a gate a Laya call.** A turn's candidates are cut the way BMO's Laya client cuts
  its request: every candidate the narrowing kept, in BMO's order, 128 to a row, each row with the
  turn's same state. A turn of up to 128 candidates is one row; one of 300 is three, of 128, 128
  and 44. No candidate is dropped for being past one call.
- **The state is BMO's state**, rewritten as above. A state longer than one Laya call reads is cut to
  its newest lines that fit, and the cut is counted.
- **The questions are BMO's questions**, rewritten as above, under their slugs.
- **The gold of a question** is a yes/no distribution: yes at 0.95 for `used` and `needed`, no at
  0.95 for `unused` and `not-needed`, and an even half for `related`.
- **A row waits until every one of its own candidates has a label.** A row with a hole in its gold is a
  row the training cannot read; it is counted as waiting and made on the pass its last label lands.
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
- **Laya is asked again, not read back.** Each turn's input as BMO builds it today is put to the Laya
  service as it serves now, so a score belongs to the checkpoint serving the gate today. A turn of
  more than 128 candidates is asked in the calls BMO's client cuts it into, and a call that fails
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

## A run and its folder

`bun scripts/reference-data.ts <run>` makes one pass, and a bare run name resolves under the runtime
data root's `reference-data/` folder, never inside this checkout.

- `labels.jsonl` — every label, appended.
- `judged/<n>.json` — each judged batch, frozen the moment its answer lands with the items it
  carried, the labels read out of it, the raw answer and the tokens it spent.
- `laya.jsonl` — Laya's answers, each with the checkpoint that gave it and the hash of the input.
- `gates/<gate>/` — the gate's rows now, in `train.jsonl`, `calibration.jsonl` and `test.jsonl`, and
  `data.json` with the counts above and a digest of the three files. The whole `gates/` folder is
  written under a partial name and put in place in one rename, so a training pass reading it reads one
  pass's rows and never half of two.
- `instruction-turns.jsonl` — every turn the bot's own instructions opened, as it was first read: its
  key, room, moment, instructions, reply and what attached. Only ever appended to.
- `turns.jsonl` — one line per turn: its key, where it was read from, its messages' numbers, whether
  what attached is known, and why it was left out where it was.
- `ticks.jsonl` — one line per pass: when, the BMO commit that built the inputs, when the archive copy
  it read was taken and that copy's schema version, how many turns stood,
  how many were judged, the calls and the tokens they spent, and how many times Laya was asked and
  reused.
- `report.json` — the figures, per gate and per τ.

## Keeping it growing

- **`bmo-gate-reference-data.timer` runs a pass every hour** over the run `ref-1`, then a training
  pass over its gates (`docs/training.md`), so the gates are trained on this data as it grows and
  nobody starts either half.
- **One pass at a time over a run.** A pass claims the run before it starts and a second one stands
  down while the first lives, since two would judge the same turns twice and put the gates in place
  under each other. Standing down is not a failure.
- **A pass judges at most sixty turns**, newest first among the turns that have a candidate with no
  label. The backlog of every room's history is drawn down at that pace, which bounds what one hour
  spends on the codex road; a pass with nothing to judge spends no call and still assembles every row.
- **The training holds a reference gate to its rarer answer as well as its rows:** a thousand rows and
  two hundred questions whose gold is yes, since a reference gate's yes answers are a few in a hundred.
- **A backlog is drawn down faster by one pass with a larger bound** —
  `bun scripts/reference-data.ts ref-1 --judge <n>` — followed by
  `bun scripts/laya-train.ts reference:ref-1`. A frozen batch is never judged again, so a pass cut off
  loses only the batches it had not frozen, and the next pass takes their turns up.
- **A kind of turn new to the data is judged ahead of the backlog** by a pass held to the turns of
  one source — `bun scripts/reference-data.ts ref-1 --source instructions --judge <n>` judges only
  the turns the bot's own instructions opened — followed by the same training pass.
- **A word is judged again by a pass of its own** (「Judging a word again」) —
  `bun scripts/reference-data.ts ref-1 --rejudge needed --before <moment> --judge <n>`, with
  `--gate <gate>` for each gate it is held to and `--road claude` while codex is shut — followed by
  the same training pass.
