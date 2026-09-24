# Whether the answer used what was attached

The four reference gates — `system-documents`, `room-rules`, `library-knowledge` and
`people-search` — each pick pieces out of a library for a turn to carry. Their Laya checkpoints were
scored against the LLM gate's own picks, and the LLM gate picks more than a turn uses, so agreement
with it cannot say which of the two is right. What settles it is the answer BMO actually sent: a
piece the answer drew on was needed, a piece it never touched was not. This document is the
canonical statement of that judgement — what is paired with what, what the judge is asked and in
which words, how the figures are read off it, and the shape its verdicts take as training gold.

## What a turn is made of

- **The candidates are the verdict record's own.** BMO's reference record keeps one row per
  candidate a gate was offered on a turn: the gate, the room, the message, the slug, the LLM's yes or
  no, Laya's where it was asked, and whether the piece actually reached the prompt
  (BMO's `docs/reference-selection.md`, 「What is recorded」). A turn is one room and one message
  across all four gates.
- **Attached means reached the prompt.** A piece the LLM wanted and the character line then dropped
  was never in front of the answer, so it is judged as offered, not as attached.
- **What reached the prompt is also in the agent log.** BMO's turn run writes one context line for
  every piece that went into its prompt, and its turn-scope line names the messages the run
  answers, so the pieces a turn attached are read off the run whose scope names that message
  (the `agent_log` table of BMO's archive). The path a context line names ends in the piece's slug. Where the
  record and the log both speak they have agreed on every row compared, so a record row that never
  said whether its yes attached takes the log's word.
- **A turn neither the record nor the log can say attached is left out.** A yes with no word on
  whether it reached the prompt cannot be told apart from one the safety line dropped. Those turns
  are counted and not judged.
- **Turns older than the record are read out of the log's gate runs.** Before the four gates stood
  apart, one classifier chose across the three libraries in one call, and the log keeps each run
  whole: the three indexes it was shown, each under its own heading, the turn's messages, and the
  slugs it answered. A run of that kind is a turn when all of this holds:
  - its prompt was kept whole — a prompt the log cut short has lost part of what was offered;
  - its answer names slugs, or none — a run that failed attached its index instead of choosing;
  - a turn run of BMO names its message in its scope — the context lines are what say what attached,
    and runs older than those lines are left out and counted.
  Its headings say which gate each candidate belongs to; the LLM's yes is the classifier's pick, and
  attached is the context line. Its probe is rebuilt as BMO's reference probe builds one from an
  index line — the gate's own question, the word its specification calls a candidate by, the slug
  and what the line says of it — over the messages the run was shown. A turn both the record and the
  log hold is the record's.
- **The person-book search records only what it named.** A person-book candidate its LLM passed over
  has no row, so its offered set is read out of the probe inputs the Laya record kept for that turn;
  a turn with neither has only its named pieces. A turn may keep several probe inputs for one gate —
  one for each call a gate too large for one call was split into — and they are read together as
  one offered set.
- **The body of an attached piece is read through its fragment row**, whose path is relative to
  BMO's live checkout for the system documents and the lore, and to the brain for the rest
  (BMO's `docs/fragments.md`). The body is read as it stands when the judgement is made. The record
  keeps no copy, so a piece rewritten between the turn and the judgement is judged in its new words;
  the run records a hash of every body it read so a later run can tell whether the same words were
  judged.
- **The reply is the first run of BMO's own messages after the turn**, within thirty minutes of it,
  taken whole up to the next message somebody else sends. Two messages BMO answered together share
  that reply, because they did share it. A turn with no reply inside the bound is left out and
  counted, since there is nothing to judge a piece's use against.
- **The judge sees the turn itself, not the room.** The turn's own messages — the run of unanswered
  messages ending at it, as the gates read it — and the reply. A session carries earlier turns'
  pieces in its context, so a reply can draw on a piece attached before; the labels below are
  written so that case lands on the piece rather than on the turn.
- **What goes to the judge leaves the rooms the way a row does.** The turn's messages are in the
  plain shape with every name and number but BMO's replaced, and the reply, every body and every
  index line are scrubbed of keys, addresses and numbers (`docs/gate-data.md`, 「What leaves the
  rooms」). A body still carries what the piece is about, since that is what is being judged.

## The judgement

One item per turn, several turns to a batch, on the codex road the real rows are judged on
(`docs/gate-data.md`, 「The codex road」), holding no thread for the same reason judging holds none.
Every candidate of every gate the turn asked is answered, and each answer is one word.

- **An attached piece is answered with one of three words.** These three lines are the judge's
  instructions word for word, and the code's prompt carries them unchanged:
  - `used` — 답이 이 문서에만 있는 내용(사실, 수치, 이름, 절차, 규칙)을 실제로 가져다 썼다.
  - `related` — 답의 주제와는 맞닿아 있지만, 이 문서가 없었어도 답이 그대로였다.
  - `unused` — 답이 이 문서와 상관이 없다.
- **A piece offered and not attached is answered with one of two**, read off its index line alone,
  which is as far as a piece the answer never saw can be judged:
  - `needed` — 답이 이 문서가 다룰 내용을 담고 있거나, 이 문서가 없어서 틀리거나 모자랐다.
  - `not-needed` — 답에 이 문서가 필요하지 않았다.
- **Nothing in the item says which side picked what.** The judge is not told the LLM's yes or
  Laya's; an attached piece is marked attached because the answer saw its body and an offered one
  did not, and that is the only difference the judge is shown.
- **The bounds of one item.** A reply is cut at 8,000 characters and an attached body at 6,000; a
  batch holds at most eight turns and 60,000 characters of items, always taking one turn however
  long it is.
- **An answer is read per candidate and a gap is not a no.** A candidate the judge left unanswered,
  or answered with a word not offered for its kind, has no label and stays out of every figure.

## The figures

- **The gold of a candidate.** `used` and `needed` are yes; `unused` and `not-needed` are no;
  `related` is contested and stands out of every comparison of sets, since either answer about it is
  defensible.
- **Over-selection** of a gate is the share of its attached pieces judged `unused`, with `related`
  counted beside it rather than inside it.
- **Missing** of a gate is the number of turns where some piece it did not attach was judged
  `needed`, and the number of such pieces, beside the turns it was asked on.
- **Laya is asked again, not read back.** The recorded probe input of each turn and gate is put to
  the Laya server as it serves now, so a score belongs to the checkpoint serving the gate today and
  not to whichever one answered when the turn ran. A gate the server does not serve has no Laya
  figure. An answer is kept beside the checkpoint that gave it, and a later run reuses it while the
  server still serves that checkpoint for the gate, so a run asks only about the turns that are new
  to the checkpoint.
- **Laya's verdict on a turn** is the set of candidates it gives a yes at or above even odds, across
  every probe input the turn kept for the gate, and its confidence on the turn is the lowest of its
  per-candidate confidences — which is what a gate in `filter` compares with τ (BMO's
  `docs/laya.md`).
- **At each τ** the figures are the share of turns Laya would settle, and of those, how many its set
  matched: against the use gold on the uncontested candidates, and against the LLM gate's own set,
  the old measure kept beside the new one. The LLM gate's own accuracy against the use gold is read
  off the same turns, so the two are held to one bar.
- **The figures are read twice**: over every turn, and over the record's turns alone. The log's
  turns were chosen by the classifier the four gates replaced, so the LLM gate a Laya checkpoint is
  held beside today is the one the record's turns show.
- **The rarer answer is counted before anything is trained.** For each gate: its rows, the
  questions whose gold is yes (`used` or `needed`), the ones whose gold is no, the contested ones,
  and how many rows hold at least one yes. A gate whose yes answers are few teaches a model to say no
  and scores well doing it, so this count is what says whether a gate has data yet.
- **A gate goes to `filter` on these figures only by 하스's word.** Where he has named a bar, the
  measure says whether the gate cleared it at some τ on both counts, and at which τ it covers most
  turns while doing so.

## The training shape

The use verdicts are gold a reference gate can be trained on, in the shape every frozen row takes
(`docs/gate-data.md`, 「A run folder」).

- **The state is the turn rebuilt as the real rows build it** — the turn's messages in the plain
  shape, with every name and number but BMO's replaced and every secret scrubbed
  (`docs/gate-data.md`, 「What leaves the rooms」). The recorded probe input carries the room's real
  names and is never written into a row.
- **The questions are that turn's own**, as its probe asked them — or, for a log turn, as the
  rebuilt probe asks them.
- **A row carries at most as many candidates as its gate's specification offers.** A probe input
  larger than that is cut the way the real rows are cut (`docs/gate-data.md`, 「The real
  conversation source」): sets of the gate's maximum in the order the candidates stand, a remainder
  short of the minimum reaching back over the set before it. Laya reads each question beside the
  state on its own, so the cut changes how the rows are packed and not what a question teaches. The
  person book is where this matters: a room offers hundreds of its pieces, one row carries twenty.
- **The gold of a question** is a yes/no distribution: yes at 0.95 for `used` and `needed`, no at
  0.95 for `unused` and `not-needed`, and an even half for `related`. A question the judge left
  unlabelled leaves its row out, because a row with a hole in its gold is a row the training cannot
  read.
- **The row's id and split** are its input's hash and the split that hash fixes, as for every real
  row, so the same turn lands in the same split whichever gold it carries.
- **Every row is checked against its gate's specification** before it is written, and a refused row
  is counted by its reason.

## A run and its folder

`bun scripts/reference-use.ts <run>` measures, and a bare run name resolves under the runtime data
root's `reference-use/` folder, never inside this checkout.

- `batches/<n>.json` — each judged batch, frozen the moment its answer lands with the turns it
  carried, the labels read out of it, the raw answer and the tokens it spent. A turn is judged once:
  a run taken up again, or run again after the record has grown, plans batches over the turns no
  frozen batch carries and leaves the frozen ones as they are.
- `turns.jsonl` — one line per turn: where it was read from, its gates, every candidate with the
  LLM's yes or no, whether it attached, and the judge's label.
- `laya.jsonl` — Laya's answer for each turn and gate it serves, with the checkpoint that gave it.
- `gates/<gate>/` — the training rows in the layout a judging run leaves while it grows
  (`docs/gate-data.md`, 「A run folder」): a progress file, and one batch of rows for every judged
  batch, frozen once under the judged batch's own number and never rewritten. A judged batch whose
  turns give a gate no row still freezes that gate an empty batch, so the numbers run unbroken.
  This is what lets the curve pass read the run as it reads any judging run.
- `ticks.jsonl` — one line per run of the script: when, how many turns stood and how many were new,
  the calls made and the tokens they spent, and how many times Laya was asked and how many answers
  were reused.
- `report.json` — every figure above, per gate and per τ, with the calls made and the tokens spent
  over the run's whole life.

## Keeping it growing

- **`bmo-gate-reference-use.timer` runs the unit every hour, over the run `use-1`.** The unit judges
  the turns no frozen batch carries, writes the figures and the gate batches, and then runs one curve pass over the run
  (`docs/laya-train-run.md`, 「Training while the judging runs」), so the reference gates are trained
  on this gold as it accumulates and nobody starts either half. A run with no new turn spends no call.
- **The curve pass over this run holds a gate to its rarer answer as well as to its rows.** Beside
  the thousand-row floor every gate is held to, a reference gate waits until two hundred of its
  questions are gold yes: the floor's own reckoning is a thousand rows with the rarer answer a fifth
  of them, and a reference gate's yes answers are a few in a hundred.
- **The old judging of these four gates is not their data any more.** The real-conversation run
  judged their rows by asking a model whether the conversation needed a piece, never by what the
  answer used, so its reference-gate rows are the LLM's over-selection taught back. The judging of
  that run is stopped, so its own curve finds no new row to train these gates on.

## The person book's asks

- **The person book is asked in calls of at most 128 candidates**, one Laya call to each set of the
  room's pieces in the order its index stands, every call over the same state. Laya's verdict is the
  union of the calls' yes answers and its confidence the lowest across them. A room offering four
  hundred pieces is four calls, well under the client's two seconds at the measured 160 ms a full
  call (`docs/laya-server.md`, 「Measured on the 3080」).
- **Each call's input is recorded as its own probe input**, which is what makes the offered set
  readable afterwards and the gate trainable at all. The asking and the recording are BMO's client;
  what stands here is the reading of several inputs as one turn and the cut of each into rows.
- **Every offered piece is judged.** Leaving a room's other pieces out of the judgement would leave
  every row with a hole in its gold, and a row with a hole is not trained on. What it costs is read
  off the ticks: the offered index lines of a room like the owner's are most of what a judged turn
  sends.

## What run `use-1` measured

On 2026-09-24, over every turn the record and the log could give: 599 turns, 228 from the record and
371 from the classifier's runs. Left out: one record turn with no reply, four whose yes neither the
record nor the log says attached, and of the classifier's runs 161 whose prompt the log cut, two that
failed, and 487 with no turn run naming their message — the runs older than the context lines, and
the messages BMO took no turn on. The turns were judged in 107 calls of `gpt-5.6-terra` at high
effort: 1,773,018 fresh input tokens, 1,184,000 read from the cache and 497,881 of output. The 396
turns the log and the record's later rows added cost about 2,000 fresh and 660 out a turn, less than
the record's own turns since a classifier turn offers fewer pieces.

- **What the LLM gates attached and the answer did not use**, on every turn:

  | Gate | Turns | Attached | used | related | unused | Over-selection | Turns missing a piece |
  |---|---|---|---|---|---|---|---|
  | `system-documents` | 599 | 239 | 38 | 155 | 45 | 19% | 85 |
  | `room-rules` | 595 | 221 | 41 | 89 | 89 | 41% | 139 |
  | `library-knowledge` | 599 | 201 | 18 | 69 | 114 | 57% | 103 |
  | `people-search` | 150 | 238 | 75 | 101 | 62 | 26% | 33 |

- **The LLM gate's whole set against the use gold**, on the record's turns, which are the four gates
  of today: `system-documents` 77%, `room-rules` 64%, `library-knowledge` 48%, `people-search` 39%.
- **The checkpoints serving today against the use gold**, every turn — trained on the old gold, so
  this is the bar a retrained checkpoint has to beat and not a figure of one:

  | Gate | Checkpoint | τ 0 | τ 0.7 | τ 0.8 | τ 0.9 |
  |---|---|---|---|---|---|
  | `system-documents` | `real-1-hand2` | 9% (599) | 6% (126) | 3% (38) | 0% (1) |
  | `room-rules` | `real-1-hand` | 61% (595) | 74% (297) | 71% (157) | 81% (31) |
  | `library-knowledge` | `real-1-hand` | 55% (599) | 79% (310) | 84% (221) | 87% (130) |

  No gate clears 98% at any τ.
- **The rows, and how few say yes** — one row an input, the rarer answer being `used` or `needed`:

  | Gate | Rows | Rows holding a yes | Yes questions | No questions | Contested |
  |---|---|---|---|---|---|
  | `system-documents` | 577 | 121 | 123 | 1,176 | 151 |
  | `room-rules` | 580 | 160 | 268 | 5,158 | 89 |
  | `library-knowledge` | 587 | 116 | 166 | 4,794 | 69 |
  | `people-search` | 22 | 5 | 12 | 402 | 2 |

  No gate reaches the thousand rows, and `system-documents` and `library-knowledge` are short of the
  two hundred yes answers as well, so nothing is trained yet; the hourly unit trains each gate the
  pass it clears both. The record has been adding something over a hundred turns a day.
- **`people-search` has 22 rows**, from the five turns whose probe fit one call. Its other 146 turns
  have only the pieces its LLM named and no offered set, and wait on the person book's asks being
  recorded.
- **What `needed` is worth.** It is read off an index line alone, and a session carries pieces from
  earlier turns, so a reply can hold a piece's content without the piece being attached that turn.
  The missing counts above are the upper reach of what the gates left out, not a floor.
