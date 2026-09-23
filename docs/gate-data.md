# The ten gates' distilled data

What this repository is: a generator that writes the distilled training data for the ten Laya split
gates, a runner that drives ten of them at once on the codex account, and the reading that says
whether what came out is good enough to train on.

## What it answers to

- **The specification is BMO's `docs/laya-gates.md`** — which gate asks what, of which transcript
  shape, with which answers, drawn to which language mix and which answer balance.
- **This repository does not restate that specification and does not amend it.** The gate
  descriptions, the row shape, the batch plan, the fourteen reasons a row is refused and the
  figures an audit reports all come across as they stand.
- **Where this document and the specification differ, the specification is right.** Numbers repeated
  here are repeated so a reader can see what the code enforces without leaving the page; they are
  not a second source.
- **No τ is chosen here, and no gate is moved off `shadow`.** Those are 하스's.
- **Nothing in BMO is written by anything in this repository.** Its checkout is read for the
  specification and nothing else. The data lands in the shared runtime data root, which is where
  BMO's training driver looks for it.

## The codex road

The rows are written by `codex exec`, driven directly rather than through any provider switch.

- **One held thread per gate.** A gate's whole run rides one codex thread. The first batch opens it;
  every later batch resumes it by its thread id.
- **The gate's fixed prefix is the thread's first message.** That prefix is the gate's rules, the row
  shape and the worked example — the part that is the same in every batch of that gate. Sending it
  once and resuming means the model reads it out of the cache afterwards instead of being told it
  again.
- **The model and the reasoning effort are named on every call, resumed calls included.** A resume
  that does not name the model falls back to the account's default, and this login rejects that
  default outright with `turn.failed` — so a run that named the model only on the first batch would
  lose every batch after it.
- **The tier is Reliable**: model `gpt-5.6-terra`, reasoning effort `high`.
- **The batch goes in on stdin, and the door shuts behind it.** A gate's prefix runs to tens of
  kilobytes, which is no size for a command line. Codex left holding an stdin nobody will write to
  waits on it, says `Reading additional input from stdin...` and gives up, so the stream is closed
  the moment the batch is written. A resumed call is told outright to read its prompt from there.
- **Every spawn runs unattended**: approvals and the sandbox bypassed and the git-repository check
  skipped.
- **The road runs in a directory holding nothing.** Codex reads an `AGENTS.md` where it is started
  and follows it, so a run started inside a checkout carries that checkout's instructions into
  every batch, unasked and paid for. The working directory is never a checkout and never the run
  folder.
- **The per-batch timeout is sized for a long answer**, not for a gate's one-word verdict: a batch of
  twenty invented rows is minutes of writing.

The shape of it, per gate:

```
thread = null
for each batch in the gate's plan:
    if thread is null:
        answer = codex exec (fixed prefix + this batch's ask)   # opens a thread
        thread = the thread id the run reported
    else:
        answer = codex exec resume thread (this batch's ask)     # prefix read from cache
    freeze whatever rows the answer held
```

### Reading a codex run

- The run is read from its event stream, one JSON object per line.
- **The thread id** comes from the thread-started event. It is what the next batch resumes.
- **The answer** is the text of the completed item that is the agent's message.
- **The usage** comes from the turn-completed event: input, cached input, cache-write input, output
  and reasoning output.
- **A completed item of the error kind is not a failure.** Those arrive as cosmetic notices — a note
  about model metadata, for instance — and the turn goes on to complete normally.
- **A failed turn is a failed batch**, and the message it failed with is carried through rather than
  being flattened into an empty answer. A rejected model and a throttle look nothing alike and the
  run should say which one it met.
- **A failed batch stops its gate rather than being written down as lost.** A model this account
  may not use fails the same way on every batch, and a gate that carried on would spend its whole
  plan recording that it could not write anything. The batches already frozen stand, and the gate
  is taken up again once the cause is gone.

### The output schema, and why there is none

Codex will constrain an answer to a JSON schema and enforces it rather than merely suggesting it,
which would make a malformed answer impossible. **It cannot be used for these rows.** The enforced
form requires every object in the schema to be closed — each one naming its properties and
forbidding any other — and a row's questions and its gold are keyed by the names the gate's own
questions carry. Those differ from gate to gate and cannot be written down in one schema that
serves ten. A schema leaving any object open is refused outright, before the model is reached.

So the answer arrives as ordinary text and the reading is what has to be robust. It is:

- **The list is found by walking the brackets**, not by taking everything between the first `[` and
  the last `]`. Rows carry what a gate really receives, and that includes fenced code blocks, logs
  and text full of brackets; a reader slicing on the outermost brackets it can see reads the data
  as the answer's own punctuation and throws away a batch that was perfectly good.
- **A fence is unwrapped only where the answer cannot be read without doing so.** Unwrapped first, a
  fence standing inside a row's own content is taken for the fence around the answer.
- **Where the list is not whole, the rows inside it are read one at a time.** A model writing long,
  deeply nested rows miscounts the braces closing them and leaves the list broken around rows that
  are themselves perfectly good. The rows are what was asked for; the brackets between them are
  punctuation, and a batch thrown away over them is a batch bought and burnt.
- **A row is refused, never fatal.** Every part of a row is looked at before it is used, so a
  question or a gold the model left half-written costs that row and not the gate's whole run.

## A run

A run is a name, a set of gates, a number of rows per gate and a batch size.

- **The ten gates run at once**, one per thread, one per folder. Nothing a gate writes is read or
  written by another.
- **Rows per gate defaults to what the specification asks for.** The driver does not invent a
  different number; a smaller one is asked for by hand, which is what a smoke run does.
- **A batch is frozen the moment it lands**, so nothing the model has already answered is asked for
  twice.
- **Progress is written after every batch**, which is what makes a run readable from outside while
  it is still going and resumable per gate if the driver itself dies. A dead driver costs no more
  than the batches that were in flight.
- **A full run is carried by a unit of its own**, because it is a day's work — far longer than any
  session, terminal or job that might start it. The unit always resumes and never overwrites, so a
  crash, a failure or a reboot takes up at the batch after the last one frozen. It writes its own
  log beside the data, and the log belongs with the run rather than with whoever started it.
- **A gate that cannot be written at all fails the same way however often it is tried**, so the
  unit gives up after a bounded number of tries in an hour and stays failed where that can be seen,
  rather than asking for the impossible all day.
- **Rows asked for is set by the floors, not by habit.** The floors are what the specification
  fixes; the number of rows is only a means to them, and it is chosen so that the smallest split
  still clears its floor once the gate's refusals are allowed for. A gate that comes up short is
  built again asking for more.
- **A gate that falls over costs only itself.** The other nine keep writing, what the fallen one
  had frozen stands, and the run says which gates did not finish.
- **Starting a gate over takes away what stood in its folder first.** Freezing reads every batch
  present, so a batch of the replaced run left behind would land in the replacement's dataset —
  and a gate rebuilt because it missed its bars would carry the very rows that missed them.

## A run folder

Everything a run makes stands under one folder named for the run.

- **`gates/<gate>/`, one per gate** — that gate's own frozen batches, its three splits, its language
  sidecar, its generation meta and its progress.
- **`dataset/`** — the ten gates merged into one dataset, which is the folder the training driver is
  given.
- **Inside a gate's folder**: `batches/` holding one file per landed batch, beside the raw text of
  any batch worth looking at afterwards — one nothing could be read out of, one whose list came
  back broken and had its rows read out singly, and one that read perfectly well and left no row
  standing. The last of those matters as much as the first: a gate that comes back empty has to be
  answerable for, and the answer is the only thing that says whether the model wrote nothing, wrote
  the wrong shape, or wrote rows the gate refused. Then `train.jsonl`, `calibration.jsonl` and `test.jsonl`;
  `languages.jsonl` naming each row's language bucket; `synth.meta.json` with that gate's figures
  and token tally; `progress.json` with how far it got and which thread it rode.
- **The merged folder holds the same three splits and the same two sidecars**, with every gate's rows
  in them together and one meta whose gate list covers all ten.
- **The merge refuses to stitch two different runs together.** Model, effort, road, rows asked, batch
  size and split shares must agree across the per-gate metas, or there is no single dataset to make.
- **Nothing in the merged folder marks it as a rehearsal**, so the training driver reads it as the
  real data it is. The mark travels two ways — a meta file of its own, and a mark on the rows —
  and a gate carrying either is kept out rather than quietly turning the whole dataset into a
  rehearsal.
- **A gate's folder holding rows that are not that gate's is refused.** Each gate freezes only its
  own, so rows of another gate mean two runs have been mixed, and that is said rather than merged.
- **No row goes in twice.** Where a row id stands twice, one copy goes in and the double is
  counted and reported, because a dataset holding a row twice weights it twice in training.
- **A gate short in any one of the three splits is named by the merge**, not found out by a
  training run failing on it. The training driver refuses such a gate outright and trains the
  rest, so a dataset short anywhere trains nine gates and reports the tenth as a fault.
- **A run folder never lands inside this checkout.** A frozen dataset is runtime data, and what sits
  untracked in a checkout is one `git clean` from gone. A bare run name resolves under the shared
  runtime data root; an absolute path is taken as given.
- **The training driver is handed the merged folder by absolute path**, because a bare name means
  something else to it.

## Resuming, and not writing over

- **A resumed run takes up at the batch after the last one frozen.** The batch plan is a pure
  function of the gate, the rows wanted and the batch size, so a resumed run asks for exactly what
  the dead one would have asked for next.
- **What stands in the folder settles where a gate takes up, not the count the dead run kept of
  itself.** A run killed between freezing a batch and recording that it did leaves a count one
  behind the batches on disk, and a resume trusting the count would buy that batch from the model a
  second time and write the answer over rows that were already good.
- **Counting stops at the first batch missing rather than counting files.** A gap means the batches
  past it were written against some other plan, and taking them would leave a hole nothing can fill.
- **The rows a batch kept and the lost answers beside it are read back off the files.** What a batch
  refused and what it cost were only ever in the count, so a batch the count never heard of takes
  those with it — and they are left missing rather than guessed at.
- **Every file a stopped run leaves for the next one is written whole or not at all**, by writing
  beside the real name and renaming onto it. A resumed run treats what stands on disk as fact, and a
  half-written file would be a lie it has no way to catch.
- **A folder that already holds a frozen dataset is never written over unless the run says outright
  that it means to.** A dataset is what a training run's figures are bound to for as long as anyone
  believes them.
- **A folder holding a half-written run is refused too**, and the refusal names both ways out:
  continue it, or start it over.

## The bars a gate must clear

Two readings, and a gate must pass both. Three of the figures are read off what the model wrote
before anything was filtered, and two off a sample of what survived freezing — the generator refuses
a bad row before it freezes, so the frozen rows always conform and only the pre-filter figures say
whether the model was any good.

| Figure | Read off | Passes at |
|---|---|---|
| yield | what was written | at least 0.70 |
| format breaks | what was written | at most 0.10 |
| repeats | what was written | at most 0.05 |
| answer drift | the frozen sample | at most 0.05 |
| language drift | the frozen sample | at most 0.05 |

And the floors, counted over all of a gate's rows: at least 4,000 training rows, at least 1,000
carrying the rarer answer, at least 1,000 held out for evaluation.

- **The two drifts are held to the finished dataset's tolerance.** A looser one exists for a
  hundred-row sounding, where a language drawn to five per cent cannot be hit at all and the figure
  measures the instrument rather than the data. A full run is not that, and its own tolerance
  governs it.
- **No sixth figure is computed.** Every one of these already comes out of the audit, and inventing
  another would be setting a bar the specification did not set.
- **A gate that misses any of them is built again**, and only that gate. The others stand.
- **The verdict names what missed and by how much**, so a gate sent back is sent back for a reason
  somebody can act on. Each of the three floors is named on its own, because a gate short of
  training rows and a gate short of held-out rows are put right by different things.
- **The reading ends badly when any gate missed**, so the rebuild can be driven off the verdict
  rather than off somebody having read it.
- **A gate whose run left no meta does not pass.** The three figures read off what the model wrote
  stood only in that meta, so without it they are not zero and not cleared — they cannot be read
  at all, and a gate nobody can judge has not been judged.

## The ledger

Per gate, for the run: rows written and rows kept; the three split counts; batches done and batches
lost; refusals broken out by reason; the token tally with fresh input and cached reads kept apart;
and the wall time.

- **Fresh input and cached reads are separate figures.** Codex reports an input count that already
  includes the cached part, so the fresh figure is that count less the cached one. Added together
  instead, every cached batch would read as though it had been paid for in full — which is the
  opposite of what holding a thread per gate achieves.
- **There is no price in the ledger, and the ledger says so.** This account is a flat-rate ChatGPT
  login: codex reports tokens and no charge, because per-token charging is not what this account
  does. The tokens stand in for a price that does not exist.
- **A road that reports no price announces it** rather than writing a zero somebody finds later and
  reads as free.
- **A gate that never started is left out of the ledger**, not entered as a row of zeroes. A row of
  zeroes reads as a gate that ran and produced nothing, which is a different thing entirely.
- **The run's wall time is the run's own**, from its first gate starting to its last one
  finishing. Gates written beside each other take the time of the longest, not the sum, and a
  ledger adding them together would report ten hours for a run that took one.

## Running it

- `bun scripts/laya-synth.ts` — write the gates' rows, one codex thread and one folder each. How
  many write at the same time is given, so one gate can be rebuilt on its own or all ten run
  together. It writes its own log beside the data.
- `bun scripts/laya-status.ts` — how far a run got: batches done against planned, rows kept, lost
  batches, refusals by reason and whether a gate is still riding its thread. It reads the folders
  and attaches to nothing, so it answers while a run is still going.
- `bun scripts/laya-merge.ts` — the per-gate folders into the one dataset folder.
- `bun scripts/laya-audit.ts` — the figures per gate, and the verdict against the bars.
- `bun scripts/laya-ledger.ts` — the ledger for a run.

Each takes `--help` and says what it wants.

A full run is not started by hand. It is the systemd user unit `bmo-gate`, whose unit file stands
in this repository and is symlinked into the user's own unit directory:

- `systemctl --user start bmo-gate` begins it, or takes it up again where it stopped.
- `systemctl --user status bmo-gate` says whether it is still going.
- `bun scripts/laya-status.ts <run>` says how far it got, which is the reading to use while it is
  going, since the unit's own state says only that it is running.

When it has finished, the three readings that close a run are the merge, the verdict and the
ledger, in that order. A gate the verdict names is built again on its own and the three are run
once more.
