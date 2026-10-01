# Training the gates

How a gate's data becomes a calibrated checkpoint and a table: where the data comes from, when a
gate is trained, how the gates are spread over the four training nodes, what one gate's run on a
node does, what a checkpoint carries and where it is kept, and what the tables say.
`docs/laya-server.md` is the training loop and its fixed settings, and BMO's `docs/laya.md` is the
canonical account of the filter as a gate asks it — the modes, the τ comparison and the verdict
record. This document adds no mechanism to either.

- **What the tables are for:** they are the evidence for whether a gate's trained model is worth
  putting in service at all. A pass that produces checkpoints and no tables has produced nothing to
  decide on.
- **Nothing here is put in service** (「What training never touches」).

## Where the data comes from

A training pass reads its gates from one **source**. A source knows its own gates and answers the
same four things for each: how many rows each of the three splits holds now, how many questions carry
the gate's rarer answer, the bars the gate is held to, and a copy of its rows for a pass to train on.
The driver asks those four and never which kind of source it is talking to.

- **The reference data** (`docs/reference-data.md`) — the folder a reference-data pass puts in place,
  one gate a folder, with its counts beside the rows. Its gates are held to a thousand rows and two
  hundred questions whose gold is yes.
- **A judging run** (`docs/gate-data.md`, 「A run folder」) — a run of the other gates, read at its
  whole batches while its judging goes on: the batches are read from the first and the reading stops
  at the first one missing, since a batch is renamed into place whole and one still being written
  cannot be seen. The split files a finished gate writes are not read, since a reader beside the
  judging could catch one half-written. Its gates are held to a thousand rows.
- **A dataset folder** — three split files holding the rows of any gates, such as a rehearsal
  (「Rehearsal」). Its gates are held to nothing but having rows in every split.
- **Any of these topped up** with a top-up run (`docs/gate-data.md`, 「Invented data」), given as
  `--top-up <run>` beside the source. Each gate's copy takes the source's own rows and then the
  top-up run's rows of that gate in training and calibration; a top-up row that landed in the test is
  dropped, so the test is the source's own. The counts and the rarer answer are read off the two
  together, the bars are the source's own, and the source is named after both, `<source>.<top-up>`,
  so its curve is a series of its own and never mixed with the points the source earned alone. The
  top-up is read at its whole batches, the way a judging run is.
- **A row's split is fixed where the row is made** — by its input's hash for a judging run and by its
  turn for the reference data — so a row held out for the test in one pass is held out in every pass
  after it, and two points of one gate are measured on one test set that only grows.
- **Rows are copied, not pointed at.** A pass copies each gate's three files into its own folder
  before anything goes to a node, and trains on that copy for its whole life, however the source
  moves under it.

## When a gate is trained

- **A gate below its floor is not trained**, nor one with any of the three splits empty. At the
  fifteen per cent held out for each of the calibration and the test, a thousand rows is about a
  hundred and fifty test rows; with the rarer answer a fifth of them, one standard error of the
  balanced accuracy is about four points there and widens past five under a hundred rows. Below the
  floor two passes would differ by chance more than by what the data taught.
- **A gate held to its rarer answer waits until that many of its questions carry it**, a question
  counting toward the answer its gold gives at three to one or more. The row floor reckons with the
  rarer answer a fifth of the rows; a gate whose rarer answer is a few in a hundred clears the rows
  with too little of it to learn from or to be measured on.
- **A gate is trained again once a quarter of its rows are new** to its last trained point: rows whose
  id its last pass did not carry, counted against the rows that pass carried. A row is new because the
  data grew, or because its input changed — a reference gate whose index lines BMO rewrote has new
  rows without having grown — and either is new data. A learning curve moves with the logarithm of the
  data, so points a constant ratio apart are evenly spaced along it, and the cost of every pass a gate
  ever gets is bounded by a few times the cost of its last one rather than by how often the timer
  fires.
- **A gate whose training failed is tried once more on the next pass**, since most failures are a
  node's rather than the gate's; failed twice on the same rows, it waits for them to change, so a gate
  that cannot be trained is not sent to a node on every pass.
- **A pass with nothing to train trains nothing and writes nothing.**

## A pass

- **`bun scripts/laya-train.ts <source>` is one pass**, where the source is `reference:<run>`,
  `judging:<run>` or `folder:<path>`. `--gate` narrows it to named gates, `--dry-run` says which gates
  it would train and why the rest wait, and `--show` prints the curve.
- **One pass at a time per source.** A pass claims its source's curve before it starts and a second
  one stands down while the first lives. Standing down is not a failure — the pass already going is
  doing the work — so a timer's unit does not read as failed for it.
- **The nodes are stood up at the start of every pass** (「The nodes」), the files that differ from
  this checkout put across, and a node whose card is busy is left out of that pass rather than shared.
- **Each pass is a training run of its own**, named `<run>-p0001` and on, with its gates' rows, its
  ledger and its tables under the runtime data root's `laya-runs/`, so a pass's name is what its data,
  checkpoints and logs are called on the nodes. A new name every pass is what lets the data go across
  once per run and never again while it lives.
- **A node takes the next gate waiting the moment its own is done**, so a node that drew a small gate
  is not left idle beside one that drew a large one; a gate's round is how many gates its node had
  taken by then.
- **A node's card is read again right before every gate it is handed**, because the card is shared
  with work that is not a pass's: BMO's voice training puts each of its stages on whichever of n3, n4
  and n5 has a free card, and a gate on a card already carrying one runs one of the two out of memory.
  A card without room for a gate — less free than the seven gigabytes one training reserves — takes
  no gate; a process holding less, such as BMO's resident voice server once it has let its model go,
  leaves the card free, since it stands on every node and counting it would keep every card from
  ever training. Where the free memory cannot be read, a process on the card is what takes it. Its
  node reads it again every minute while gates are still waiting, for half an hour at most, and then drops out of the pass; the gates it did not take go to
  the nodes still working, or stay for the next pass. A node that does not answer the reading drops
  out at once.
- **A node whose gate did not finish takes no other gate in that pass** — out of reach, or a training
  that fell over. A node failing in seconds would otherwise take every gate still waiting and fail
  each the same way while the nodes that work sat idle. A gate no node was left to take keeps its line
  in the ledger and says so, and is picked up by the next pass.

## The nodes

- **Four nodes, n2 to n5.** n6 is not one of them: it serves the checkpoints (`docs/llm-server.md`),
  and a training run would take its card. Every node command refuses a node outside these four by
  name before anything reaches it.
- **`bun scripts/laya-nodes.ts` stands the environment up**, and `--check` reads the nodes and
  installs nothing — it does put the probe script across where a node has none, that being how a node
  is read at all. It asks each node what it carries, puts across only the files that differ from this
  checkout, builds or refreshes the venv from the pinned project file, and prints the nodes side by
  side — GPU, free VRAM, CUDA, python, the installed package versions, free disk, and what is on the
  card.
  - **It installs into the account alone:** no sudo, no system package, and nothing written to the
    account's shell profile. CUDA goes on the path of the run rather than of the account.
  - **Every node's venv is the same interpreter**, fetched by uv rather than taken from the system, so
    a figure measured on one node means the same on the next. A venv standing on the system's
    interpreter is read as not ready and is made again.
  - **A node whose card already carries a process is left exactly as it is** — no file put across, no
    install started — because the process is another gate's run or somebody else's work.
  - **An install already in flight is waited on, not started again.** Installing takes longer than
    the hub holds a streamed command open, so it is detached on the node and read back out of its log.
- **Every node is reached through the jake console**, never by SSH, and every transfer is bounded and
  made twice at most (`docs/laya-server.md`).

## One gate on one node

What runs on the node is the committed `node-train.sh` and the training scripts beside it; this side
composes the calls, reads the answers and decides the next move. **What to do next is read off the
node, never remembered here**, so a run somebody else started, or one a pass started and lost, is
picked up rather than begun again.

1. **The data goes across once.** The gate's three files are put on the node before its first launch
   and never again while the run lives, since a resume is bound to the very file its training started
   on. A gate whose data could not be put across fails on its own and costs its node nothing else.
2. **The training is started detached** with `setsid` and its output in a log, because the hub stops
   a command it is streaming and the stop reaches the whole process group.
3. **Nothing is started on a card somebody else holds.** Right before a launch, a resume and a
   calibration the card is read again, since the card stands free between the gate's own processes
   and another training can take it in that gap. A card without room for a gate is waited on, and the wait
   is a run that does not move, so the hour below bounds it; a node that does not answer the reading
   is out of reach.
   - **The node's card lock is held through every use.** The training, a resume and the calibration
     each take the node's shared card lock (`docs/llm-server.md`, 「The shared card lock」) before
     anything goes on the card and hold it until the process ends, waiting for it where another
     service has it — the text model's engine, which holds the lock of every one of n2 to n5 while it
     runs and for its idle minute after, or a voice line. The free memory reading
     alone cannot stop a service that follows the lock from putting its model on the card after the
     gate has started. A launch waiting for the lock says so in its log, and that wait is a run that
     does not move too.
4. **A run is waited on while it moves.** The largest gates train for hours, so no clock bounds the
   wait; a run whose log has grown by no line, whose step has not moved and which has not passed from
   training to calibrating for an hour is given up on with the log's last line.
5. **A run that died is carried on from its newest step checkpoint**, which is carried off the node
   first. It is carried on at most five times; a gate that keeps dying is given up on with the count
   and the log's last line. A run that died leaving nothing to carry on from is named rather than
   written over — removing somebody's checkpoint is nobody's to do quietly.
6. **A finished run is calibrated**, with the gate's own declaration of which answer Laya may settle
   handed over as a flag. A calibration counts as this training's only where its log is newer than
   the training that finished.
7. **The checkpoint measured beside it** is the one serving the gate on n6 today, where the service
   serves the gate and the collection holds that checkpoint: it is put on the node and measured on the
   same test rows, so the table's before and after are one computation on one set. A gate nobody
   serves is measured beside the checkpoint it was trained from.
8. **The finished checkpoint is carried back**, and the gate's line written into the ledger.

## The training script and its settings

- **`finetune.py` is what runs**, launched directly. The loop is a single-GPU adaptation of the
  official notebook: each run trains one gate's model on a card of its own, so nothing is sharded and
  no process group is started.
- **`laya` is pinned exactly at 0.3.5**, the fine-tuning reading internals that carry no promise
  across versions. The node's venv is built by uv from the pinned project file and from nothing else.
- **Quality comes first, and the settings are fixed for every gate and every node:** micro-batch 4
  accumulated to an effective 64, bf16, gradient checkpointing, four epochs. They are not tuned per
  gate.
- **No saving is used** — neither frozen embeddings nor the 8-bit optimizer — and the batch is not
  reduced either. The one thing left for a card that runs short is optimizer offload, and it is
  reached only if a measured peak comes near the card's 12 GB (`docs/laya-server.md`, 「What the
  savings cost」). A saving is a measurement's to justify, never a guess's.
- **Every trained model is calibrated.** Temperatures are fitted on the calibration split and the
  figures are measured on the test split, which is neither trained on nor fitted on.
- **The calibration writes the report the tables are assembled from**, into the checkpoint itself so
  it travels with it, and prints the same thing so the run's log carries it too.
- **Which answer a gate may settle is the gate's own declaration**, handed to the measurement as a
  flag; nothing in the measurement keeps a list of which gates are asymmetric.

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
  already there reads the marker and never the directory's existence.
- **Retention:** a run keeps its newest two step checkpoints (`--keep-checkpoints`) and drops the
  rest, and only once the new one stands whole. The newest is never dropped. When the run finishes,
  its final checkpoint is written at the top of the run directory and the step folders are dropped
  with it.
- **A resume has to be the same run.** The seed, the epochs, the batch, the savings, the learning
  rates and the digest of the train file are recorded with the state, and a resume that finds any of
  them changed stops and names what moved rather than continuing a different training in the first
  one's directory.
- **The contract is demonstrated, not asserted.** A run killed inside a save left its interrupted
  step under a partial name and the step before it whole; the resumed run read that step and
  reported step 2, epoch 1 of 2, item 128 of 252 — not step 0 and not item 0 — and finished the epoch
  in the time the remaining 124 items take.

## Checkpoint naming and collection

- **A checkpoint is never left only on the node that made it.** A run's newest step checkpoint is
  carried back when the run is found dead, before it is carried on, and its final checkpoint when it
  finishes. Every rolling save is not carried back — a step checkpoint runs to some gigabytes and the
  tunnel would spend the run's own time on copies the next save makes stale.
- **Where they are collected:** `workbench/worker/laya-checkpoints/` under the runtime data root, a
  folder per gate, the run under it, and the step under that — `<게이트>/<실행>/step-000025`. The
  workbench outlives a session and a job, which a checkout's own ignored folder does not.
- **It travels as one file.** A checkpoint is packed on the node into an uncompressed tar, brought
  over, weighed against the hash the node gave, and unpacked here under a partial name that is given
  its own only once everything is in it. The tarball is cleaned off the node afterwards.
- **A finished checkpoint travels without its rolling saves.**
- **A manifest stands beside each collected checkpoint:** the gate, the run, the node it was trained
  on, the step, whether it is final or rolling, the size in bytes, the file count, the hash, where it
  stood on the node, when it was collected, and whether the run was a rehearsal. What stands in the
  collection is read from those manifests rather than from an index kept beside them.
- **A checkpoint already collected under the same gate, run and step is never written over.**
- `bun scripts/laya-collect.ts` carries one back by hand, and `--list` says what has been carried back.

## The ledger and the curve

- **The ledger** is the pass's own record, one line a gate: the node it ran on, the round, when it
  started and ended, how many steps it took, how many times it was resumed, the elapsed seconds, the
  peak VRAM, the batch shape, the precision, the card it ran on, the checkpoint and the logs on the
  node, what the calibration came to and the whole report it wrote, the checkpoint measured beside
  it, where each checkpoint was carried back to, and the fault where there was one. It is written
  under the pass's folder in `laya-runs/`.
- **The curve** is `curve.jsonl` under the runtime data root's `laya-curve/<source>`, one point a gate
  a pass, appended in one write and never rewritten: the pass, when, the training run's name, the
  gate, the rows it was trained on and how many of them each split holds, the digest of those rows,
  the node, whether the training finished, the agreement, the balanced accuracy, the calibration
  error, the seconds, and the fault where there was one. A point that failed keeps its line and says
  why. The row ids a point was trained on are kept beside it, since the next pass counts its new rows
  against them.

## The tables

`bun scripts/laya-tables.ts <pass>` makes them out of that pass's own ledger — the calibration's
report rides in it — so nothing is read a second time and nothing can have moved in between. It
prints the sheet and writes it beside the ledger; `--json` gives the same figures as numbers.

- **The before-and-after table**, one row a gate: how many test questions it was measured on, what
  the checkpoint measured beside it came to — the one serving the gate today, or the one it was
  trained from — and what the new one came to, each as accuracy, balanced accuracy, the share of the
  gate's yes answers it gave back, and calibration error, with the difference beside each.
  - **Accuracy is agreement with the gold**, which is the teacher's own answer: a model that agrees
    with it is right by that measure and by no other.
  - **Balanced accuracy is what says a training worked.** A model that always gives a gate's common
    answer scores high on plain agreement and decides nothing.
  - **The yes answers given back are counted apart** because they are the rarer answer of every
    reference gate: a checkpoint that learns to say no scores well on everything else.
  - **A gate whose run left no report keeps its line** and says what stopped it, because a table that
    quietly holds fewer gates than were trained is a table that has been read wrong.
- **The missed calls stand in a table of their own**, threshold by threshold, for every gate that
  declares an answer Laya may settle: how much of the gate the settleable answer would have taken,
  how many calls it would have missed, and that count as a share of the calls that wanted an answer.
  A missed call is not an accuracy; for 응답 여부 판정기 it is a message that wanted an answer and would
  not have had one.
- **The per-node table** is the ledger's own: the gate, the node, the round, the state, the steps,
  the resumes, the elapsed time, the peak VRAM, the batch shape and the precision.
- **A table built from rehearsal rows says so on every line of every table**, and again at the top of
  the sheet. A line lifted out of a table must not read as evidence.

## Rehearsal

Rehearsal data is a deterministic, model-free fixture carrying the gates' names in the three splits,
made so the resume, the driver, the collection and the tables can be exercised whole without real
data. `bun scripts/laya-rehearsal.ts --out <폴더>` writes one under the runtime data root, never in a
checkout, and refuses a folder already holding a frozen dataset.

- **Each row is its gate's own worked example with the words a person would read swapped** and the
  fields the gate declares as choices cycled, so it is the shape that gate really receives. Every
  row is put through that gate's own validator before anything is written.
- **The answers are taken in turn**, so every answer of every question is taught.
- **The same seed writes the same dataset**, and every split holds what it owes.
- **Every rehearsal row carries a marker**, the folder carries one of its own, every checkpoint
  trained on one is marked, and a table built from them says so on every line.
- **A rehearsal figure is never evidence.** It says the machinery works, never that a gate does.

## What training never touches

- **A gate's `laya_mode` and `laya_tau` stay as they are.** Choosing τ and moving a gate off
  `shadow` is 하스's decision, made after he has seen that gate's numbers (BMO's `docs/laya.md`,
  「Who decides」).
- **The Laya service keeps serving what it serves.** No checkpoint produced here is named in the
  service's settings; putting one in service is `bun scripts/laya-serve.ts`, run on 하스's word
  (`docs/llm-server.md`).
- **The gate options table is not written at all.**
