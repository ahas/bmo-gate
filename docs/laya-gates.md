# The Laya gates

A specification of the Laya gates: the output format and the reply-or-not gate. It fixes, for each gate, the
input it receives, the question it asks Laya, the answers it may give, and whether it is asymmetric — and
beside those, the language mix and the answer balance its distilled training data is to be drawn to.

- **This is a target specification, not a description of what runs.** The reply-or-not gate has no gate code
  at all. Each section says which gates run and how.
- **What it is for:** the distilled data is generated against this document, the training and the
  verification are measured against it, and the structural split implements it. Where the built gate and
  this document differ, one of them is wrong and it is said so rather than quietly settled.
- **`docs/laya.md` is the canonical account of the filter as a gate asks it** — the modes, the τ
  comparison, the verdict record and the probe contract. This document adds no mechanism; it only says what
  each gate asks.
- **No τ is chosen here.** Choosing τ for a gate, and moving a gate off `shadow`, is the owner's and no job's
  (`docs/laya.md`, 「Who decides」).
- **The questions' own wording is English**, and stands in the gate's Laya question data, one entry per gate
  key and question, with the word a candidate is named by. The distilled data carries the same words, and a
  checkpoint is trained on them. Only a row's state is the rooms' own words, as they were written. This
  document gives each question's meaning; the data holds its wording.
- **A gate asks its checkpoint the wording that checkpoint was trained on.** A checkpoint trained on an
  earlier, Korean wording of its gate's question has not learnt the English one, so while it serves it is
  asked the Korean wording it learnt, word for word (`docs/laya.md`, 「Each gate's probe」). The formatting
  gate's checkpoint in service is one such, and stays in service as it is. A checkpoint retrained on the
  English wording is asked the English one. Rows written in a Korean wording stay usable: the tooling reads
  them as asking the English one (`docs/gate-data.md`, 「A question reworded」).

## Which gates Laya serves

- **The formatting gate alone:** `output-format`, whose provider is Laya, with its companion
  `output-decide`, an earlier fold checkpoint served beside it under that name that no gate of this
  repository asks (`docs/laya-server.md`, 「Which checkpoint answers which gate」).
- **Every gate's specification stands below as it is,** served or not: it is what the gate's data was drawn
  to and what any checkpoint of it would be trained on.

## Question types

- **Two types only: `noul` and `choice`.** A `noul` question is answered yes or no; a `choice` question is
  answered with one of its named options. The `score` type exists in the client and no gate uses it, so no
  gate here asks one.
- **Each gate here asks one question of one input,** and is settled whole.
- **What one call holds:** at most 128 questions, a state of at most 768 tokens and a question of at most
  256. Every row of every gate's data fits inside that or it is not a row.
- **A row is one call's worth.** A turn whose gate asks more than 128 questions is not cut short: the
  client asks it in several calls — its questions in their order, 128 to a call, each call with the same
  state — and the turn is as many rows as it is calls.

## The transcript shapes

A gate's data is written in the line shape that gate really receives.

- **A message is one entry, not one line.** Its own text may carry newlines, and one answer of the chat
  agent's routinely runs to a dozen of them; those later lines stand without a prefix and belong to the
  entry above them. So a transcript stands in its gate's shape when the first line of it carries the
  prefix, and nothing is read off how many of the lines after it do — a real turn of a real room has far
  more continuation lines than prefixed ones, and weighing the two against each other refuses the very
  shape the gate is handed at every turn it runs. What that test refuses is a state that is prose rather
  than a transcript, and prose does not open with a sender and a number.
- **A message's own number may be negative.** A room's record numbers some of what it holds from below,
  and both the shape and the test on it carry the number as given rather than one of their own.

- **The plain shape** — one line per message, the sender's name, the sender's number and the text:

  ```
  <sender name> (id <sender number>): <text>
  ```

  The number reads `unknown` where the message carries none. There is no timestamp and no reply marker in
  this shape. No gate here is given it; the tooling keeps it for a gate that reads a turn's messages alone.

  A quiet instruction the chat agent was handed — a job's state, a deployment's notice, a document's update
  notice, a watch's note — is an entry of its own in the same transcript, with no sender and no number,
  since it is nobody's words:

  ```
  quiet instruction from the bot: <text>
  ```

  A turn the chat agent's instructions opened with no message is a transcript of such entries alone.

- **The pipe shape** — one line per message, six fields, the reply marker last:

  ```
  <message number> | <time> | <sender number> | <sender name> | <text> [replies to <message number>]
  ```

  The time is an ISO 8601 instant at the deployment's own offset. The trailing marker stands only on a
  message that is a reply. This is the shape the person-book writing road reads. No gate is given it.

- **The room shape** — what a gate reading a room's recent messages is handed: the time in brackets, the
  message's own number after a hash, the sender's name, the sender's number with an owner tag where the
  sender is the owner, the text, and then the notes the message carries:

  ```
  [<time>] #<message number> <sender name> (id <sender number>, OWNER): <text> <note>…
  ```

  The time is an ISO 8601 instant in UTC. `, OWNER` stands only on the owner's own messages. A note is a
  bracketed English sentence appended after the text, one per thing the message carries — a reply, an
  attached image, an attached file. A reply's note names the message replied to and who sent it, or says
  the room's record no longer holds it. A message with nothing attached and no reply carries no note at
  all. This is the shape the reply-or-not gate is specified to take.

- **What the data carries:** the sender's number and name, the time and the reply marker, and the input
  exactly as the chat agent really receives it. The room shape carries every one of them, so the gate that
  judges a room's situation, the reply-or-not gate, is specified on it.

- **Attachments** are placeholders in the text, not separate fields, each a marker word of the room
  language in brackets, as the room's record writes it:

  | What arrived | What stands in the line |
  |---|---|
  | a photo | the photo marker, the caption after it where there is one |
  | a voice message | the voice marker with `<minutes>:<seconds>`, the minutes unpadded and the seconds two digits |
  | a file | the file marker with the file's name, the name absent where the file carries none |
  | a sticker | the sticker marker with its emoji and `(<set name>)`, each part only where it exists |
  | a video | the video marker with `<minutes>:<seconds>` |
  | a video note | the video note marker with `<minutes>:<seconds>` |

- **Rooms come in three kinds** and the data carries all three: the owner's private room, a room with
  several people in it, and a room another AI sits in. Only the first two are told apart by the gates — as
  `owner` and `group` — so a room with another AI in it is a `group` room whose speakers include one that is
  not a person. That distinction lives in the conversation rather than in a field, and the data carries it
  the same way.

- **The chat agent's own messages** stand in the lines the reply-or-not gate reads, since a message following
  the chat agent's own answer is exactly the case that gate has to judge.

## The language mix

`laya-multilingual` is one model, so each gate has one dataset and the languages are mixed inside it in the
proportion that gate really meets.

- **The three buckets:**
  - **The room language** — the prose is the room language throughout. English appears only as a borrowed
    word, an identifier, a path or a fragment shorter than a line.
  - **English** — the prose is English throughout, with no sentence of the room language in it.
  - **Mixed** — sentences of both stand together in one state, or a message in the room language carries a
    block of English longer than one line: a log, a code block, a stack trace, a list of paths.
- **The share each gate is drawn to**, and why it is that share:

  | Gate | Room language | English | Mixed | Why |
  |---|---|---|---|---|
  | `output-format` | 65% | 5% | 30% | the chat agent's answers are in the room language by the answer-language rule and carry code blocks, paths and logs inside them more often than any other gate's input |
  | reply-or-not | 80% | 5% | 15% | a room's recent talk, which is the room's own language |

- **The tolerance is ±5 points per bucket.** A generated dataset whose bucket falls outside that is
  regenerated for that gate rather than accepted.
- **Accuracy is measured per bucket, not only overall**, so a model that holds up in one language and
  collapses in English is visible rather than averaged away.

## The answer balance

The real distribution of these gates is lopsided — a message is folded or said to the agent less often than
not — and data drawn to it teaches the model to give the common answer always, which agrees with the
gate as often as a real judgement and decides nothing. So the data is drawn balanced and the lopsidedness is
left to τ.

- **A yes/no gate:** each answer 50% of its questions, ±5 points.
- **A choice gate:** each option an equal share, ±5 points.
- **The floors per gate:** at least 4,000 training rows, at least 1,000 rows or questions carrying the rarer
  answer, and at least 1,000 rows held out for evaluation.

## Which model writes the rows

Two models can write this data: `claude-opus-5` at medium effort, which costs tokens, and the deployment's
own text model, `qwen3.8-27b`, which costs none. The model that costs none is taken where it is good enough,
and whether it is is settled by measurement against the bar below rather than by reading a sample and
forming an impression.

- **The bar is written before the pilot runs.** A bar set after the figures are in is not a bar.
- **The pilot:** about 100 rows for each of two gates chosen for their distance — the reply-or-not gate, the
  simplest, and the answer-content gate, the hardest — written by each model against the same specification
  and scored with the same audit.
- **The five figures, each read off what the model wrote rather than off what survived:**

  | Figure | What it says | passes at |
  |---|---|---|
  | yield | the share of written rows that answered their own gate | at least 0.70 |
  | format breaks | the share refused for a transcript in the wrong shape, or unreadable as a row at all | at most 0.10 |
  | balance drift | how far the answers fell from the even split, at its furthest | at most 0.15 |
  | language drift | how far the languages fell from the gate's ratio, at its furthest | at most 0.15 |
  | repeats | the share of written rows that were a row already written | at most 0.05 |

- **Why these and not the audit's other share.** The generator refuses a bad row before it freezes, so the
  frozen rows always conform; the figure that says whether a model was any good is what it wrote before
  that filter, and only the run's own meta still holds it.
- **The bars are looser than the specification's own** — the finished dataset is held to ±0.05 on balance
  and language — because a 100-row pilot with a forced answer in each batch is a noisier thing than 7,500
  rows, and the pilot is deciding a model rather than accepting a dataset.
- **What each outcome settles:**
  - the local model meets all five on both gates — the full generation runs on it;
  - it misses any one of them on either gate, and `claude-opus-5` meets them — the full generation runs on
    `claude-opus-5` at medium;
  - neither meets them — nothing is generated, and the question goes to the owner, since a dataset built on
    a model that cannot hold the format is worse than no dataset.
- **The batch plan draws the language within the batches leaning on each answer,** so no answer can be
  emptied by a language the model cannot write, and a row's language is read off what was said, with the
  line's prefix taken off, never off the sender's name. The gate's own question text stands verbatim
  whatever language the messages are in.

## What the pilot settled

The pilot, 100 rows of each gate on each road, same bar, same audit:

| | local, reply-or-not | local, content | opus, reply-or-not | opus, content | passes at |
|---|---|---|---|---|---|
| yield | 1.00 | 0.78 | 0.93 | 0.90 | ≥ 0.70 |
| format breaks | 0.00 | 0.00 | 0.01 | 0.03 | ≤ 0.10 |
| balance drift | 0.25 | 0.01 | 0.10 | 0.09 | ≤ 0.15 |
| language drift | 0.20 | 0.20 | 0.15 | 0.15 | ≤ 0.15 |
| repeats | 0.00 | 0.00 | 0.00 | 0.00 | ≤ 0.05 |
| lost batches | 1 | 0 | 0 | 0 | none |

- **`claude-opus-5` at medium effort met the bar.** It meets all five on both gates; the local model misses
  the language on both and the balance on one. That is the second outcome registered above, reached by the
  rule rather than by preference. The rows themselves are written on the two roads `docs/gate-data.md`
  names, codex and the local-model road; no road carries claude.
- **What the language figure is worth.** At a hundred rows one batch is a fifth of the run, so a language
  drawn to five per cent cannot be hit at all and the drift cannot fall below about fifteen points however
  good the model is. The figure separated the two models here, but it is a coarse instrument at this size and
  the full run's own ±0.05 is what actually governs the dataset.
- **What each road costs, measured.** The Claude road holds its session — 265,109 cache-read tokens against
  90 of new input — at $0.63 a twenty-row batch. The local-model road returns no usage at all and keeps no
  session, and runs about three times slower per batch.

## The output format

- **Status:** the one formatting gate, on the key `output-format`, whose provider is Laya: the fold is
  Laya's verdict alone, and the markup is the code's. It is declared by the dialect that folds.
- **Input:** the markdown as the chat agent wrote it, reduced so a message of any length fits one call — the
  reduction is fixed to the character, since the gate builds the same state from the same markdown:
  - the text is trimmed of the whitespace around it;
  - `head` — where the whole costs no more than 520 tokens in the generous count, the whole text; otherwise
    the longest opening costing at most 320, ended at the last line break where one falls in its latter
    half;
  - `tail` — empty where `head` holds the whole; otherwise the longest closing costing at most 200, begun
    after the first line break where one falls in its former half;
  - `chars`, the characters of the whole; `lines`, its lines that are not blank; `paragraphs`, its runs of
    lines that are not blank; `items`, the lines opening with a list mark (`-`, `*`, `+`, `•`, or a number of
    up to three digits and `.` or `)`); `headings`, the lines opening with one to six `#`; `code`, the fence
    lines halved and rounded up; `table`, the lines opening with `|`;
  - where escaping would carry the state past 768 tokens, both excerpt budgets are cut to three quarters, a
    half and a quarter in turn, and the first that fits — or the quarter — is the state.
- **What the judge reads:** the markdown whole, never the reduction (`docs/gate-data.md`, 「Judging the real
  rows」).
- **Question:** one yes/no — should this message go into the room folded, wrapped in an expandable quote.
- **Answers:** fold or open.
- **Asymmetry:** none. A wrongly folded message is a cosmetic error either way.
- **Note:** whether the converted text keeps the original, and tag validity, escaping and nesting, are the
  conversion code's and its tests', never a model's, so they are not questions here.

## The reply-or-not gate

- **Status:** no code. What decides whether the chat agent wakes is the receiver's name match and the
  room's conversation window, with no model and no gate in it. This gate is new.
- **Input:** the room's recent messages in the room shape — the time, the message's number, the sender's
  name and number, the text and the notes — with the message being judged handed over separately from the
  ones before it, and the kind of room beside them. The chat agent's own messages stand in these lines.
- **Question:** one yes/no — is this message said to the chat agent, the agent named by its registration's
  label.
- **Answers:** said to the agent, or certainly not said to the agent.
- **Asymmetry:** yes, and the only answer Laya may settle is certainly not said to the agent. Anything else,
  however confident, wakes the agent.
  - **The settleable answer is the expensive one** — a message wrongly judged not to be the agent's is an
    answer never given — and it is settleable because it is the only answer that saves anything: settling that the message is said to the agent runs the agent, which is
    what would have happened anyway.
  - **What makes it safe is τ, set high**, and that number is the owner's. Verification of this gate counts
    the missed calls — the messages that wanted an answer and were judged not to — as a figure of its own,
    apart from accuracy.
- **What the data must carry**, because this gate lives or dies on them:
  - Rooms where the agent was called by name and rooms where it was not.
  - Rooms whose conversation window is open and rooms whose is shut.
  - A message aimed at the person next to the agent that happens to carry the agent's name in it.
  - A message that names nobody and is plainly a question put to the agent.
  - A single word continuing the agent's own last answer.
  - Another AI in the room saying its own name aloud to itself.
