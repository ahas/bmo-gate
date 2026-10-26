# Gate evaluation set

## What it is for

- **A fixed set of questions per gate, each with its answer key,** so a gate's quality on one road can
  be put in numbers beside its quality on another: the Claude model the gate's tier maps to on Claude
  Code, and a registration of the deployment's own text model, which the off-turn gates run on.
- **The questions are the gate's real input.** An item holds the material a gate is handed in its
  own terms (a transcript, a part of a document), and the gate's own code builds
  the request from it: the gate's system prompt and the prompt its caller writes. What the gate
  answers is read by the reader its caller uses.
- **The gate it covers** is the session summariser, `session-summary`.

## The members

- **One member per gate,** in the tool's `gates` folder, each answering the same contract:
  - the gate's work key;
  - the brief Codex is given: what the gate does, its real system prompt, an example request as
    the gate's code builds it, the item's shape and how to write easy and borderline questions;
  - the topics batches cycle through, the batch size and how many items the gate is asked for;
  - the closed JSON schema of one item, which Codex enforces on its answer;
  - the reading of one item, refusing one that the gate's code could not ask about or whose key does not
    fit what the gate will be shown;
  - the request the gate's code builds from an item;
  - the score of an answer against the item's key.
- **A member is its own file and the words beside it:** what its brief says around the gate's real
  prompts, its topics, its example input and its cases stand in a data file of its own in the gate's
  `prompts/gate-eval/` folder, since they are worded for the model that writes the items, and its code
  holds no Korean of its own. The rule every brief gives for an accepted form stands there too.
- **A member may carry cases of its own,** beside the items Codex writes: an input the gate answered
  wrongly in use, rewritten by hand with nothing of a room in it so that it still draws the same
  wrong answer, with its key. They stand in the member's data file, are read by the member's own
  reading, and are asked in every scoring of every set after the set's own items, whatever its
  limit; their ids carry the word `case`.
- **The folder is the list.** Each member registers itself with the tool, so a gate is added by
  adding its files and naming the module in the folder, and no list outside the folder changes.
- **A member reads its gate's prompts as the gate's run does:** the gate's own instructions as the gate
  holds them, and a rulebook through the agency's `GET /rulebooks`.

## What each gate is asked and how it is scored

- **session-summary** — the tail of a room session or a worker session, built into the transcript
  by the gate's own code. The key is the facts the note must carry, the strings it must not, or `none`
  for a tail with nothing to carry. Passes where the note keeps to its 1,200 characters and meets the
  key.
- **Every member's score is a pass and a share:** the share of the key's checks the answer met, so a
  gate that misses one fact in ten is told apart from one that misses all of them.
- **Literal matching is the whole of the scoring.** A fact is matched by any of its accepted
  strings, so the key names the distinctive words, numbers and names a faithful answer cannot do
  without, each form at most two words and 20 characters; an item whose key holds a longer form is
  dropped. No
  model judges another model's answer.

## Generation

- **Codex writes the items, driven directly** by `codex exec`, never through the agency's provider switch:
  the provider order and Codex's switch are not read or changed. The tier is Reliable, model
  `gpt-5.6-terra` with reasoning effort `high`, named on every call.
- **Every gate runs on its own,** all of them side by side, each in one Codex thread: the first batch
  carries the brief, every later batch resumes the thread with its own ask. The thread is opened
  afresh where the gate's brief has changed since it was opened, and every few batches so it never fills its context, and the new thread is told the topics
  already written so it does not repeat them.
- **A batch asks for a number of items on one topic,** about half of them easy and half borderline,
  and the answer is held to the member's schema by Codex itself.
- **Each item is read before it is kept.** An item the member refuses is counted under its reason
  and dropped; an item whose input repeats one already kept is dropped as a duplicate.
- **A gate's kept items are read again by its member each time its generation starts,** so an item
  a rule tightened since refuses leaves the set. An id is never given twice.
- **Codex runs in an empty folder,** so no instruction file of a checkout reaches it, and its prompt
  goes in on standard input.
- **A refusal is counted, never worked around.** A batch whose turn Codex fails on a usage policy, or
  whose answer is a refusal rather than items, is a refused batch; the items it was asked for are
  counted as refused. Three refused batches in a row stop the gate, which is then left for a model that writes it.
- **Any other failed batch stops its gate** (a spent limit, a model the account may not use), and the
  gate takes up where it stopped on the next run.
- **No archive conversation is sent out.** Every input of a set is written by Codex, and every case by hand; nothing of a room, a
  person book or a session leaves the machine.

## Where the data is

- Under the data root's `gate-eval` folder, one folder per set (`v1` unless named; a set named by an
  absolute path is that folder), one folder per gate inside it:
  - `items.jsonl` — the kept items, one per line;
  - `batches.jsonl` — one line per batch: its topic, how many items were asked, kept, refused, dropped
    and why (the first item of each reason said whole), its tokens and seconds;
  - `state.json` — the gate's thread, its next batch and whether it is running, done, stopped or
    refused.
- Scores go to the set's `scores` folder: one line per item and road, and a summary per run.

## Scoring

- **The runner asks each gate on a road it names,** through the gate's own run with that road put in
  place of the gate's configured one: the gate's own options (answer size, thinking, time limit)
  stand.
  - `claude` asks the gate on Claude Code, on the model its tier maps to there.
  - `registered` asks the registration `--registration` names, through the agency's model gateway.
- **One gate's items are asked one at a time,** so a time is one answer's whole wait.
- **On Claude the gates are asked side by side; on a registration one gate after another.** The
  deployment's own text model has one slot, shared with the chats and every gate on it, so gates asked
  together would time the queue rather than the answer. A run on it holds that slot for as long as it
  takes, so it is run when the chats can wait.
- **Per gate and road it reports** the items asked, passed, the mean share, the answers that did not
  come, and the median and 90th-percentile seconds.

## Commands

- `bmo gate eval start [--set <name>] [--per-gate <n>] [--batch <n>] [--gate <gate>]…` — starts the
  generation as the transient user unit `bmo-gate-eval`, which outlives whoever started it, run by
  the binary the command was run with, in the folder it was run in, on the settings file it read.
- `bmo gate eval generate [...]` — the same generation in the foreground; the unit runs this.
- `bmo gate eval status [--set <name>]` — per gate: kept, asked, refused, dropped, left, and
  its state.
- `bmo gate eval score --road claude|registered [--registration <name>] [--set <name>] [--gate <gate>]… [--limit <n>]`
  — asks the gates and writes the scores; `--limit` takes that many items of each gate, spread evenly
  over its set.
- `bmo gate eval report [--set <name>]` — the last score of each gate on each road and model, side by
  side: a registration is a road of its own.
- `journalctl --user -u bmo-gate-eval` is the unit's own log.
