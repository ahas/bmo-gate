# The split-gate training run

The gates of `docs/laya-gates.md`, each trained as a Laya model of its own across the four
training nodes, calibrated, and measured into two tables. This document is the run: what it trains
on, what a checkpoint carries, how a killed run carries on, how the gates are spread over the nodes,
what the tables say, and how the gates are trained again and again while their judging still runs.
`docs/laya-server.md` is the training loop and the settings every run here uses, and BMO's
`docs/laya.md` is the canonical account of the filter as a gate asks it — the modes, the τ
comparison and the verdict record. This document adds no mechanism to either.

- **What the tables are for:** they are the evidence for whether a gate's trained model is worth
  putting in service at all. A run that produces checkpoints and no tables has produced nothing to
  decide on.
- **Nothing here is put in service.** The run leaves every gate's mode and τ as it found them
  (「What the run never touches」).

## The data it trains on

- **The distilled folders**, frozen one per gate under the runtime data root's synthesis folder and
  never in a checkout. Each holds the three splits a training reads — `train.jsonl`,
  `calibration.jsonl` and `test.jsonl` — split by input hash, so one input never sits in two.
- **The archive's own verdicts are not a source here.** They were given by gates whose prompts and
  structure have since moved, so they say which turns a gate was asked about and nothing more
  (`docs/gate-data.md`). What the split gates train on is the rows built from the rooms' own
  conversation and judged afresh, and nothing else.
- **Rehearsal data is a fourth thing and is not training data.** It is a deterministic, model-free
  fixture carrying the same gate names in the same three splits, made so the resume, the
  driver, the collection and the tables can be exercised whole before the distilled folders exist.
  `bun scripts/laya-rehearsal.ts --out <폴더>` writes one under the runtime data root, never in a
  checkout, and refuses a folder already holding a frozen dataset.
  - **Each row is its gate's own worked example with the words a person would read swapped** and the
    fields the gate declares as choices cycled, so it is the shape that gate really receives. Every
    row is put through that gate's own validator before anything is written, and a row the validator
    would refuse stops the writing rather than being counted.
  - **The answers are taken in turn**, so every answer of every question is taught and no gate's
    rehearsal data is all one answer.
  - **The same seed writes the same dataset**, and a gate's rows are gone on with until each of its
    three splits holds what it owes — a split with nothing in it is a calibration or a measurement
    that cannot run at all.
  - Every rehearsal row carries a marker, the folder carries one of its own, every checkpoint
    trained on one is marked, and a table built from them says so on every line. The row's mark is
    what travels: a row copied elsewhere carries it, and the folder's file does not.
  - **A rehearsal figure is never evidence.** It says the machinery works, never that a gate does.

## The training script and its settings

- **`finetune.py` is what runs**, launched directly. The loop is a single-GPU adaptation of the
  official notebook, whose own `train_ddp.py` shards one model across two T4s under DDP. Here each
  run trains one gate's model on a card of its own, so there is nothing for DDP to shard and
  nothing for `torchrun` to rendezvous: no process group is started.
- **`laya` is pinned exactly at 0.3.5**, the fine-tuning reading internals that carry no promise
  across versions. The node's venv is built by uv from the pinned project file and from nothing else.
- **The settings are fixed for every gate and every node:** micro-batch 4 accumulated to an effective
  64, bf16, gradient checkpointing, four epochs. They are not tuned per gate.
- **No saving is used** — neither frozen embeddings nor the 8-bit optimizer — and the batch is not
  reduced either. The one thing left for a card that runs short is optimizer offload, and it is
  reached only if a measured peak comes near the card's 12 GB (`docs/laya-server.md`, 「What the
  savings cost」).
- **Every trained model is calibrated.** Temperatures are fitted on the calibration split and the
  figures are measured on the test split, which is neither trained on nor fitted on.
- **The calibration writes the report the tables are assembled from**, into the checkpoint itself so
  it travels with it, and prints the same thing so a run's log carries it too.
  - It measures **the base model on the very same rows** in the same run, so the difference is one
    computed number rather than two runs a reader is left to subtract. The base is the checkpoint
    this one was trained from, as its own training wrote down, rather than whatever the hub holds
    today. The card holds one model at a time, so the trained one is let go of before the base is
    loaded.
  - **Which answer a gate may settle is the gate's own declaration**, handed to the measurement as a
    flag by the run; nothing in the measurement keeps a list of which gates are asymmetric.

## The resume contract

- **Where a run's step checkpoints stand:** a `steps/` folder inside the run's own directory, one
  folder per saved step, named by the step so a listing reads in order. `--resume` takes the run
  directory and reads the newest whole one out of it.
- **What a checkpoint carries**, so that a run can be continued and not merely inspected:
  - the model weights, in the precision they are trained in,
  - the optimizer state,
  - the scheduler state,
  - the completed optimizer-step count and the epoch it falls in,
  - what fixes the data order — the seed and the position reached within that epoch's order. Each
    epoch's order is drawn from its own seed rather than from the epochs before it, so the epoch a
    resume lands in is rebuilt without replaying the ones behind it.
  - a save lands only where an optimizer step has just been taken and the gradients are cleared, so
    a resumed run starts on a whole accumulation window rather than inside one.
- **The generators go with it** — the torch and CUDA random states — so the exploration noise a
  resumed run samples is the noise the killed one would have sampled.
- **It is written on a step interval**, every 25 optimizer steps by default and at every epoch's end,
  so what a killed run loses is bounded by that interval rather than by an epoch. `--save-every`
  moves the interval and 0 leaves only the epoch boundaries.
- **A step checkpoint is a checkpoint in its own right.** It carries the same files a finished one
  does, so it can be loaded and measured as it stands, with the trainer state and the
  full-precision weights beside them — the served copy is half precision, which is enough to decide
  with and not enough to go on training from.
- **A save is whole before it counts.** It is built under a partial name and renamed when everything
  is in it, so a run killed inside a save leaves nothing a resume would read, and the save before it
  is still there to carry on from.
- **A resumed run continues from the saved step** with the data order it would have had, and neither
  the optimizer's moments nor the schedule's position starts again at zero.
- **A finished checkpoint carries a completion marker.** A directory without one is a partially
  trained run, however many files stand in it. Anything that skips work because a checkpoint is
  already there reads the marker and never the directory's existence — a rolling save creates the
  directory long before the run is done, and a half-trained checkpoint mistaken for a finished one
  is a gate that never gets trained.
- **Retention:** a run keeps its newest two step checkpoints (`--keep-checkpoints`) and drops the
  rest, and only once the new one stands whole. The newest is never dropped, whatever number is
  asked for. When the run finishes, its final checkpoint is written at the top of the run directory
  and the step folders are dropped with it.
- **A resume has to be the same run.** The seed, the epochs, the batch, the savings, the learning
  rates and the digest of the train file are recorded with the state, and a resume that finds any of
  them changed stops and names what moved rather than continuing a different training in the first
  one's directory.
- **The contract is demonstrated, not asserted.** A run is killed mid-way and the resumed one is
  watched to carry on from the saved step; the step before the kill and the step it resumed at are
  what say so.

## Checkpoint naming and collection

- **A checkpoint is never left only on the node that made it**, so a node that dies is not the only
  copy of a step. `bun scripts/laya-collect.ts` carries one back, and `--list` says what has been
  carried back already.
- **The run carries one back at each moment its copy on the node could become the only one:** when a
  run is found dead, its newest step checkpoint goes first and the run is carried on afterwards, and
  when a run finishes, its own checkpoint goes. Every rolling save is not carried back — a step
  checkpoint runs to some gigabytes and the tunnel would spend the run's own time on copies that the
  next save makes stale.
- **Where they are collected:** `workbench/worker/laya-checkpoints/` under the runtime data root,
  a folder per gate, the run under it, and the step under that — `<게이트>/<실행>/step-000025`. The
  gate and the step read straight off the name; the run stands between them because two runs of one
  gate, a rehearsal and the real thing, reach the same step numbers and are not the same checkpoint.
  The workbench outlives a session and a job, which a checkout's own ignored folder does not.
- **It travels as one file.** The transfer carries a file and a checkpoint is a folder, so it is
  packed on the node into a tar — uncompressed, since a safetensors file is already dense — brought
  over, weighed against the hash the node gave, and unpacked here under a partial name that is given
  its own only once everything is in it. A transfer cut short leaves nothing that reads as a
  collected checkpoint, and the tarball is cleaned off the node afterwards.
- **A finished checkpoint travels without its rolling saves.** Those are collected under their own
  step numbers or not at all, and carrying them inside the finished one would multiply it severalfold.
- **A manifest stands beside each collected checkpoint:** the gate, the run, the node it was trained
  on, the step, whether it is a finished checkpoint or a rolling one, the size in bytes, the file
  count, the hash, where it stood on the node, when it was collected, and whether the run was
  rehearsal or real. What stands in the collection is read from those manifests rather than from an
  index kept beside them, which would be one more thing to fall out of step.
- **A checkpoint already collected under the same gate, run and step is never written over.** The
  refusal names what stands there; a caller who means to replace it says so outright.
- **Ten checkpoints fit comfortably.** A finished Laya checkpoint is a 322M-parameter model saved in
  half precision, and both the nodes and this machine have hundreds of gigabytes free.

## One gate to a node, in rounds

- **Four nodes, n2 to n5.** n6 is not one of them: it carries the house LLM service
  (`docs/llm-server.md`), and a training run would take its card. Every node command — setting up,
  reading, training, the curve's passes and collecting — refuses a node outside these four by name
  before anything reaches it.
- **A node holds one gate at a time** and a run takes its card to itself. Each node takes the next
  gate waiting the moment its own is done, so a node that drew a small gate is not left idle beside
  one that drew a large one — the gates run from minutes to hours. A gate's
  round is how many gates its node had taken by then.
- **A node whose gate did not finish takes no other gate in that run** — out of reach, or a training
  that fell over. A node failing in seconds would otherwise take every gate still waiting and fail
  each the same way while the nodes that work sat idle. A gate no node was left to take keeps its
  line in the ledger and says so.
- **The environment is stood up before a run** by `bun scripts/laya-nodes.ts`, and `--check` reads
  the nodes and installs nothing — it does put the probe script across where a node has none, that
  being how a node is read at all. It asks each node what it carries, puts across only the files that
  differ from this checkout, builds or refreshes the venv from the pinned project file, and prints
  the nodes side by side — GPU, free VRAM, CUDA, python, the installed package versions, free disk,
  and what is on the card.
  - **It installs into the account alone:** no sudo, no system package, and nothing written to the
    account's shell profile. CUDA goes on the path of the run rather than of the account.
  - **Every node's venv is the same interpreter**, fetched by uv rather than taken from the system,
    so a figure measured on one node means the same on the next, and the kernels compiled at the
    first step find their headers in the interpreter rather than in whatever the system carries. A
    venv standing on the system's interpreter is read as not ready and is made again.
  - **A node whose card already carries a process is left exactly as it is** — no file put across, no
    install started — because the process is another gate's run or somebody else's work.
  - **An install already in flight is waited on, not started again**, so the verb can be run as often
    as one likes while the first call's work is still going.
  - **What a node answers is what the reading says**, so an install that finishes and leaves the node
    short is a failure and not a ready node. Installing takes longer than the hub holds a streamed
    command open, so it is detached on the node and read back out of its log.
- **The run itself is `bun scripts/laya-train.ts --data <폴더>`**, and `--dry-run` shows which node
  takes which gate without touching anything. What runs on a node is the committed training script
  there; this side composes the calls, reads the answers and decides the next move.
- **A gate is given a node by giving it that gate's rows alone.** The training trains on every gate
  in the folder it is handed, so the dataset is cut here into one folder a gate before anything goes
  across, and a gate whose split is empty stops the run rather than being sent to a node that cannot
  calibrate it.
- **The data goes across once and is not touched again while the run lives.** A resume is bound to
  the very file its training started on, so a file put across a second time would be refused as
  another run's.
- **A gate whose data could not be put across fails on its own.** Every transfer is bounded and made
  twice at most (`docs/laya-server.md`), so a stalled upload costs its gate minutes and never holds
  the pass; the gate keeps its line with the fault, and the other gates go on under the rule above.
- **A run is detached** with `setsid` and its output redirected to a log, because the hub stops a
  command it is streaming and the stop reaches the whole process group.
- **What to do next is read off the node**, never remembered here: a run going is left alone, a run
  finished is calibrated, a run that died with a step checkpoint is carried on from it rather than
  from the base model, and a run that died leaving nothing to carry on from is named rather than
  written over — removing somebody's checkpoint is nobody's to do quietly.
- **A run is waited on while it moves.** The largest gates train for hours, so no clock bounds the
  wait; a run whose log has grown by no line, whose step has not moved and which has not passed from
  training to calibrating for an hour is given up on with the log's last line.
- **A run is carried on a bounded number of times.** A gate that keeps dying is given up on with the
  count and the log's last line, rather than being restarted for ever.
- **A calibration counts as this training's** only where its log is newer than the training that
  finished. One left by an earlier run of the same name says nothing about this one and is not read
  as its figures.
- **A node out of reach loses the gate it took and nothing else.** The other nodes carry on, and the
  gate is picked up by the next run over the same name, which reads the node afresh — or, for a
  gate trained while its judging runs, by the next pass.
- **The run ledger** records, per gate: the node it ran on, the round, when it started and ended, how
  many steps it took, how many times it was resumed, the elapsed seconds, the peak VRAM, the batch
  shape, the precision, the card it ran on, the checkpoint and the logs on the node, and what the
  calibration came to. It is written beside the run's own per-gate folders under the runtime data
  root, and it is the raw form of the per-node table.

## Training while the judging runs

A gate's judging is hours to days, and a gate need not wait for it to finish to be trained: what it
has frozen so far is already data. The gates are trained on what they hold now, trained again as
they grow, and every training leaves a point on a curve of what more data buys.

- **A pass is `bun scripts/laya-curve.ts <실행>`**, and the timer `bmo-gate-curve` runs one every
  thirty minutes, so the curve grows with the judging and nobody starts it. `--dry-run` says which
  gates the pass would train and why the rest wait; `--show` prints the curve.
- **A pass cuts every gate at its whole batches**, finished or not (`bun scripts/laya-merge.ts
  --growing` is the same cut on its own). A batch is renamed into place whole, so every batch that
  can be seen is complete; the cut reads the run of batches from the first and stops at the first one
  missing, and one being started over under it ends the run there rather than failing the pass. The
  split files a finished gate writes are not read, since the judging writes them in place and a reader
  beside it could catch one half-written; the batches are what they are made of. Nothing is written
  into a gate's folder, where a split file standing would read as a gate already finished. The
  judging needs no GPU, so the only thing the two share is that folder, and this is the whole of how
  they keep out of each other's way.
- **A row's split is the one its input hash fixed when the row was built**, at the run's own shares,
  so a row held out for the test in one pass is held out in every pass after it. Each pass measures on
  a test set that only grows, and two points of one gate are on the same footing.
- **A gate under a thousand rows is not trained**, nor one with any of the three splits empty. At the
  fifteen per cent held out for each of the calibration and the test, a thousand rows is about a
  hundred and fifty test rows; with the rarer answer a fifth of them, one standard error of the
  balanced accuracy is about four points there and widens past five under a hundred rows. Below the
  floor two passes would differ by chance more than by what the data taught.
- **A gate is trained again once it has grown by a quarter** since its last point. A learning curve
  moves with the logarithm of the data, so points a constant ratio apart are evenly spaced along it,
  and the cost of every pass a gate ever gets is bounded by a few times the cost of its last one
  rather than by how often the timer fires. A pass with nothing grown enough trains nothing and
  writes nothing.
- **A gate whose training failed is tried once more on the next pass**, since most failures are a
  node's rather than the gate's; failed twice on the same rows, it waits for a new row, so a gate that
  cannot be trained is not sent to a node every thirty minutes once its judging has stopped.
- **A gate started over is a series of its own.** A point carries when its gate's judging began, and
  a gate is only held to the points of its own series.
- **The nodes are stood up at the start of every pass**, the files that differ from this checkout put
  across, and a node whose card is busy is left out of that pass rather than shared.
- **Each pass is a training run of its own**, `<실행>-p0001` and on, with its dataset, its per-gate
  folders and its ledger under the runtime data root's `laya-runs`, so `bun scripts/laya-tables.ts
  --run <실행>-p0001` makes a pass's tables like any run's. A new name every pass is what lets the data
  go across once per run and never again while it lives.
- **One pass at a time.** A pass claims the curve before it starts, the way a gate is claimed before
  it is written, and a second one stands down while the first lives. Standing down is not a
  failure — the pass already going is doing the work — so the timer's unit does not read as failed
  for it.
- **The curve is `curve.jsonl`** under the runtime data root's `laya-curve/<실행>`, one point a gate a
  pass, appended in one write and never rewritten: the pass, when, the training run's name, the gate,
  when its judging began and whether it had finished, the rows it was cut at and how many of them
  each split holds, the node, whether the training finished, the agreement, the balanced accuracy and the
  calibration error, the seconds, and the fault where there was one. A point that failed keeps its
  line and says why.

## The two tables

- **`bun scripts/laya-tables.ts --run <이름>` makes them**, out of that run's own ledger — the
  calibration's report rides in it — so nothing is read a second time and nothing can have moved in
  between. It prints the sheet and writes it beside the ledger; `--json` gives the same figures as
  numbers.
- **The per-gate table**, one row a gate: how many test questions it was measured on, the base
  model's accuracy, the trained model's accuracy and the difference between them, the balanced
  accuracy and its difference, the calibration error and its difference, and the missed calls at the
  threshold the table shows.
  - **Accuracy and the agreement with the LLM's verdicts are the same measured quantity here** and
    stand in one column: the gold a question is marked against is the teacher's own answer, so a
    model that agrees with it is right by that measure and by no other.
  - **The base figure is measured, not assumed:** the checkpoint this one was trained from is run
    over the same test split, the same way, so the difference is a computed one.
  - **Balanced accuracy is what says a training worked.** A model that always gives a gate's common
    answer scores high on plain agreement and decides nothing.
  - **A gate whose run left no report keeps its line** and says what stopped it, because a table
    that quietly holds fewer gates than were trained is a table that has been read wrong.
- **The missed calls stand in a table of their own**, threshold by threshold: how much of the gate
  the settleable answer would have taken, how many calls it would have missed, and that count as a
  share of the calls that wanted an answer. The per-gate table shows the count at one threshold —
  0.9 unless `--tau` says otherwise, since a high τ is what makes an asymmetric gate safe — and the
  whole ladder stands underneath it.
  - **A missed call is not an accuracy**, which is why it is counted apart: for 응답 여부 판정기 it is
    a message that wanted an answer and would not have had one. Every gate that declares an answer
    Laya may settle is counted the same way; the gate the decision rests on is the asymmetric one.
- **The per-node table** is the ledger's own, so instruction 9's figures are written once and read
  twice: the gate, the node, the round, the state, the steps, the resumes, the elapsed time, the
  peak VRAM, the batch shape and the precision.
- **A table built from rehearsal rows says so on every line of every table**, and again at the top of
  the sheet. A line lifted out of a table must not read as evidence.

## What the rehearsal showed

The whole chain was put through once on one node, on the rehearsal data, and the training was killed
mid-run on purpose. What follows is what that run recorded.

- **The kill landed inside a save.** The run's own folder held `steps/step-000002` whole and
  `steps/step-000004.partial` beside it — the epoch-end save the kill interrupted. The partial one is
  not a step checkpoint to anything that reads them, so the resume had `step-000002` to carry on from
  and the interrupted save cost nothing but its own seconds.
- **The resumed run started where the killed one stopped**, which is what the training log says
  either side of the kill:

  ```
    saved step-000002 — epoch 1/2, item 128/252
  epoch 1/2: 11.6s, loss 1.3145
  items: 252 — system-documents 252
  resumed: checkpoints/killcheck-system-documents/steps/step-000002 — step 2, epoch 1/2, item 128/252
  ```

  Step 2, epoch 1 of 2, item 128 of 252 — not step 0 and not item 0. The epoch it landed in finished
  in 4.2 seconds against the 11.6 the killed run had spent on it, which is the arithmetic of reading
  the 124 items that were left rather than all 252.
- **The run was carried on by the driver itself**, not by hand: it found the training gone, carried
  the newest step checkpoint off the node, and started it again from that checkpoint.
- **Both checkpoints were collected** under names that read: `system-documents/killcheck/step-000002`
  for the rolling save the kill left, and `system-documents/killcheck/step-000008` for the finished
  model, each with its manifest saying which node it came from, what it weighs, and whether it can be
  trained on from where it stands.
- **The ledger of that run** says the training took 8 optimizer steps over 2 epochs in 27.2 seconds,
  was resumed once, peaked at 6.81 GB of the card's 12, and ran at micro-batch 4 accumulated to 64 in
  bf16 on an RTX 4070 — instruction 9's figures, measured rather than assumed.
- **The tables came out of that ledger** and every line of them says 리허설, because they are a
  rehearsal's. The machinery is what this run proves; what a gate is worth is what the real data will
  say.
- **The asymmetric gate was put through the same chain of its own**, so the missed-call table is one
  that has really come out rather than one that is only designed: 응답 여부 판정기 was trained,
  calibrated with its own declaration — `forBmo`, settling `false` — and its table carries the seven
  thresholds with the settled count, the coverage, the missed calls and the missed share beside each,
  and the line in words saying what a missed call is. On a rehearsal's handful of test rows the model
  settled nothing at any threshold, which is a fact about eight invented questions and about nothing
  else.

## What the run never touches

- **A gate's `laya_mode` and `laya_tau` stay as they are.** Choosing τ and moving a gate off
  `shadow` is 하스's decision, made after he has seen that gate's numbers (BMO's `docs/laya.md`,
  「Who decides」). No part of this run writes either column.
- **The Laya server keeps serving what it serves.** No checkpoint produced here is named in the
  server's own settings, and the unit is not restarted onto one.
- **The gate options table is not written at all**, by the driver or by anything it starts.
