# The Laya server and the training behind it

Laya is a small open decision model (`laya-multilingual`, 322M, Apache 2.0) that answers a yes/no or
multiple-choice question about a piece of text with calibrated probabilities. It stands on its own as
an installed provider: this repository holds the server, the data the checkpoints are trained on and
the training itself, and the gates hold the client that asks it and the configuration of which gate
asks (`docs/laya.md`).

## The server

- **Where it runs:** on every node the service's placement names (`docs/llm-server.md`, 「The
  placement」), each one of the deployment's registered nodes (the node unit's `docs/nodes.md`), as the engine of the Laya
  service there — the systemd user unit `bmo-llm-laya.service`, behind the service's MCP and
  OpenAI-compatible front, the tunnel that brings it to the operations machine and the relay that asks the nodes
  in order (`docs/llm-server.md`). Linger is on for the account, so the
  unit starts with the machine, with nobody logged in.
- **What it is:** the small HTTP server kept in this repository under `runtime/laya-server/`, installed in `~/bmo-laya`
  on its own Python 3.12 virtual environment, built by `uv` in user space on uv's own interpreter —
  the same venv a training node's setup builds. The service's installer, `bun scripts/llm-install.ts`,
  is the one way it is put there or updated, and it installs no system package and asks for no sudo.
- **What it compiles:** torch's native Triton kernels are built against the venv's Python the first
  time a decision meets an input shape, with the node's C compiler and the headers uv's interpreter
  carries. A kernel is built once for each of the few shapes the input padding leaves, costs 40 to 120
  milliseconds the once, and is kept in the account's triton cache on disk, so it survives a restart
  and the shapes a gate asks are warm within a handful of calls.
- **What it holds:** one checkpoint per gate, never one shared by all of them. On start it waits for
  the card lock where one is named (「Sharing the card」), loads every checkpoint the unit's settings
  name (「Which checkpoint answers which gate」) one after the other, and each makes one decision of
  its own on the card and is taken off into host memory (「Host copies」) before the next is loaded. Then it
  gives the C heap the loads left behind back to the system, rests on the card with the lock kept, puts
  the checkpoints back on it as far as the card takes them, and opens the port, so a server that answers
  `/health` can decide for every gate it names, and one whose checkpoint cannot decide stops and is
  restarted by the unit. It never falls back to the hub model: a gate no checkpoint is named for is
  refused, not answered by another gate's checkpoint.
- **One tokenizer for checkpoints that read alike:** checkpoints whose tokenizer files are the same,
  by name, size and content, share the tokenizer loaded first, since each loaded copy holds about a
  hundred megabytes of host memory for the process's whole life.
- **Its environment:**
  - `USE_TF=0`, which the model card names as the cure for a load that hangs.
  - laya, torch and transformers pinned exactly, on uv's Python 3.12, torch built for the CUDA the
    node's driver runs, which the setup has uv read from the driver.
- **While it loads** (about fifteen seconds a checkpoint from the local disk, 「Measured on the service's node」), the
  port does not answer at all; the front answers a call meanwhile with 503.
- **Port:** `7431` on the node's loopback alone. The front is the only way to it.
- **One call carries at most 128 questions**; more is refused as a request it cannot read.
- **Its two calls:**
  - `GET /health` — for each gate it serves, the checkpoint directory, where it is now (`pinned` or
    `mapped` in host memory, or on the `card`), the bytes its host copy takes (`hostBytes`), how long its last move onto the
    card took (`moveMs`, none before its first), how long it took to load and the calibration
    temperatures it carries; beside those the device, the VRAM the process holds, how many
    checkpoints may be on the card at once, the card lock (its path, whether the server holds it and
    how many calls were answered that the card is taken outright), how many decisions ran
    out of card and were asked again with room made (`roomMade`), how many calls were dropped because
    their caller had left (`droppedCalls`), and the Laya and torch versions. Its `model` line names
    every gate with its checkpoint, so a change of any one of them is a change of the model a watcher
    sees.
  - `POST /decide` — the gate asking, a state and a set of named questions in, Laya's answer for each
    question out, as that gate's checkpoint gives it: the probabilities, the chosen option and the
    confidence; beside them `ms`, what the call took here, and `waitMs`, how long it stood before the
    card was its own. A call that names no gate is refused as a request it cannot read (400); one that names
    a gate no checkpoint serves is refused as not served here (404); one that finds the card taken
    outright — a claim standing, or no place for the engine among the node's occupants — is answered
    503 at once, saying so; one whose checkpoint cannot be put on the card for want of room is answered
    503; and none of them is asked of a checkpoint. No 503 carries a `Retry-After`: a call is never told
    to come back. Each of these 503s says why under `error`, in words the gate's client reads a busy card
    from (`docs/laya.md`, 「The client」): `the card is taken for <claim>`, `the card has no room for …`, or
    `… has no place among this node's occupants`. A
    decision that does not fit on the card even with its checkpoint alone there is answered 503 too
    (「Sharing the card」).
- **One decision at a time.** Calls wait in line for the card. A call whose caller has hung up by the
  time its turn comes — the front gave up on it — is dropped unasked, with one log line and no answer,
  so calls nobody waits for any more never hold up the ones behind them. An answer whose caller left
  while it was being made is dropped the same way.
- **Token:** every call carries a bearer token, the Laya service's one key (`docs/llm-server.md`,
  「The key」), which the server reads as `LAYA_TOKEN` from the service's environment file on its node. The
  token never goes into a table, a log, a command line or the console.

- **Installing and updating:** `bun scripts/llm-install.ts` from this checkout on the operations machine, which puts
  up the whole service on its nodes (`docs/llm-server.md`, 「Installing and updating」). The gates' settings
  file, `~/.config/bmo-laya/env`, is made once naming no gate and is never overwritten.
- **Restarting it:** `systemctl --user restart bmo-llm-laya` on the node, through its connection —
  the node console's `exec` for a console node, a login for an ssh node; `journalctl --user -u
  bmo-llm-laya` there holds its log, one line per call and no request body.
- **Timing a call:** `runtime/laya-server/bench.py --gates <gate>[,<gate>…]` asks the server with 1, 10 and 50
  questions on a Korean state, from the operations machine through the relay with `--url <the relay's address>`,
  or through one node's front with that node's own listen. Given two gates it asks them in turn, which times the move between the card
  and host memory as well as the decision where one is made.

## Which checkpoint answers which gate

- **One place says it on each node:** `LAYA_CHECKPOINTS` in the gates' settings file on the service's node,
  `~/.config/bmo-laya/env` — `gate=directory` pairs separated by spaces, the whole value in double
  quotes. A directory that is not absolute is read from `~/bmo-laya`, where the checkpoints are kept
  in the layout the collection keeps them in on the operations machine: `checkpoints/<training gate>/<run>/step-<n>`.
  The gate on the left is the name the gate asks with, which is the gate's own key.
- **What decides the gate on the left is the gate's key, and the directory on the right is the training
  side's name.** Most of the two agree. Where they do not, the settings file is the one place that
  joins them:

  | Training gate (`docs/laya-gates.md`) | The gate asking | Checkpoint |
  |---|---|---|
  | `output-format` | `output-format` — the gate whose provider is Laya, asked the reduced state | served (`real-2-fold`), trained on the Korean wording of the fold question and asked it (`docs/laya.md`, 「Each gate's probe」) |
  | `output-format` | `output-decide` — no gate of this repository asks it | served (`real-1-hand`) |
  | `content-judge` | none — no gate asks it | not served; its checkpoint (`content-judge-1.content-judge-topup-1-p0001`) is kept in the collection and on the nodes |
  | `reply-wanted` | none — the reply-or-not gate has no code | trained, not served |

- **A checkpoint answers only the shape it was trained on.** The state a gate's probe sends must be
  the state its training rows carry, to the character. A checkpoint asked in another shape still
  answers, and answers the common answer to everything — a figure that looks like 0.8 agreement and
  is only the base rate. So the `output-format` reduction is written out in `docs/laya-gates.md` and
  the gate builds it from the same markdown with the same fixture under test.
- **Changing a gate's checkpoint** is `bun scripts/laya-serve.ts <training gate>/<run>/step-<n>
  --gate <gate>`, which carries the checkpoint to every service node, names it there and restarts the unit
  (`docs/llm-server.md`, 「Putting a checkpoint in service」).

## Sharing the card

The checkpoints stand on the card between decisions, as many as it takes, and the rest wait in host
memory (「Host copies」). They leave it only when another occupant of the node wants the card. The
node's card is shared with other services under one lock (`docs/llm-server.md`, 「The shared card
lock」); what follows is the mechanism, and the unit's settings are its policy.

- **The card lock:** `LAYA_GPU_LOCK` names a file the server takes an exclusive, non-blocking
  `flock` on before it puts a checkpoint on the card. It holds the lock for as long as any checkpoint
  is on the card and lets it go when it has taken them all off and emptied the allocator's cache.
  Where nothing names a file the server takes no lock.
- **A call waits for its turn inside the call:** where the node's card arbiter keeps a hold queue, the
  engine asks it for its turn before it takes the lock, through the arbiter's client carried beside the
  server (the arbiter's `docs/node-arbiter.md`, 「The hold」), standing in the queue by the call's arrival and with the answer
  held open, so the call goes on the moment the card is handed to the engine. It waits so for as long as
  its caller holds the connection, with no bound of its own: the caller's patience is the only one
  (`docs/laya.md`, 「The client」). It looks every second whether its caller is still there, and a
  call whose caller left is dropped and its ticket given back.
- **No call is answered held.** A queue turn is waited for inside the call however long it takes, and no
  answer ever tells a caller to come back later.
- **A card taken outright is answered at once:** where the arbiter says a claim stands (a claimant's task, the
  desktop, a reservation), or that the engine has no place among the node's occupants, the call is
  answered 503 naming it, without a `Retry-After` and without touching the card, so the relay asks the
  next node and the asking gate goes its own way rather than wait out a hold of minutes. Each is counted in
  `/health`.
- **A lock held by a process asking for no turns** is the one wait looked at again and again, since a
  flock announces nothing when it is let go: the arbiter grants no turn while such a process holds the
  lock and finds it freed within a quarter of a second (the arbiter's `docs/node-arbiter.md`, 「Handing on」), and on a node
  keeping no queue the engine asks for the lock every fifth of a second, for as long as the caller waits.
- **The card carries on from call to call while the next one stands first:** where a lock is named, a
  call that ends with others in hand asks the arbiter whether the oldest of them still stands first in
  the queue (the arbiter's `docs/node-arbiter.md`, 「One queue of requests」). While it does, that call is decided with the batch
  still on the card; once an occupant above Laya waits, or the turn has run the arbiter's bound with
  anybody waiting, every checkpoint comes off and the lock is let go after the call in hand, and the
  calls left wait their turn again by their arrival. On a node keeping no queue the card carries on
  while calls are in hand.
- **Between calls the card rests:** the call that ends with no other in hand keeps every checkpoint on
  the card and the lock with them, and tells the arbiter the turn rests (the arbiter's `docs/node-arbiter.md`, 「Resting」).
  - A call that comes while it rests asks the arbiter whether it carries on, as a call in hand does,
    and is decided with the batch where it stands.
  - **It gives way the moment another occupant asks for the card,** above Laya or below it, or a claim
    begins: every checkpoint comes off, the lock is let go and the ticket given back. One ask held open
    on a thread of its own hears of it, so no call waits on the hearing.
  - **It comes back once the card is free:** having given way, it asks a ticket that only rests, which
    the arbiter grants once nobody else wants the card, and the batch goes back on as the card is
    filled (below). Laya's training holding the card meanwhile is never made to give way by it.
  - A call while it is away asks its own ticket, standing as any call does, and puts its own
    checkpoint on.
  - An arbiter whose answer says nothing of resting keeps no rests: the call that ends with no other in
    hand then takes every checkpoint off and lets the lock go at once.
  - Where no lock is named, checkpoints stay on the card until a batch needs their room.
- **The turn is bounded by the arbiter, not the engine:** a claimant's task, a voice line or a song waiting for
  the lock has its turn between two calls once the engine has held the card for the arbiter's bound,
  well within the twenty seconds the
  card broker gives a holder before ending it (the text model engine's own documents, 「Giving way to a claim」).
- **The batch:** what the card should hold next, worked out each time from the card as it is and the
  calls in hand, never from a gate's name: the gate asking first, then the gates of the calls waiting
  in line, then the gates asked most recently, then every other in the settings' order — each taken
  while fewer than the card's number are in it and its card copy fits in the card's free memory, the
  copies of those already on the card and what the allocator holds unused counted as free, with the decision room
  (`LAYA_DECISION_ROOM_MIB`, 768 where nothing sets it) left over. Where the card's free memory
  cannot be read, the number alone decides.
- **A call whose checkpoint is not on the card** takes off together every checkpoint outside the
  next batch, puts its own on and decides; it never waits for the rest of the batch.
- **The rest of the batch goes on while the card is idle,** resting under a named lock or kept with
  none: holding the card with no call in hand for `LAYA_FILL_QUIET_MS` (500 where nothing sets it), the
  engine puts the batch's missing members on one at a time, the next call's wait at most one move,
  since it looks for a call in hand before each. It waits for the quiet because a caller asks a turn's
  gates back to back: a move made in the moment between two of its calls only holds up the second.
  `/health` counts the moves made for calls (`moves`) and those made ahead of them (`filled`).
- **What stays on the card without the lock** is the process's CUDA context and nothing more.
- **What a checkpoint costs on the card:** 1.2 to 1.4 GB each as `nvidia-smi` reads it — the weights
  are kept in 32 bits there, as Laya builds them. A decision needs working memory of its own beside
  them, which grows with the tokens it lays out, so the card that holds every checkpoint of eight
  gates has no room left for a large part.
- **How many are on the card at once** is at most what the card itself takes and at most
  `LAYA_CARD_MODELS` (1 where nothing sets it), fewer while a decision needs the room (below), and
  the others wait in host memory. What the card takes is counted once, when every checkpoint has
  loaded and none is on the card: the card's free memory then, which leaves out the engine's own
  context, less what is kept free for others there
  (`LAYA_CARD_KEEP_FREE_MIB`, none where nothing sets it) and the decision room, over the largest
  checkpoint's card copy, and at least one. The start says both numbers in the journal. That is offload
  and nothing else: a checkpoint's weights are the same numbers
  wherever they wait, and its answers are the same to the last digit after any number of moves,
  measured on four checkpoints over three rounds each.
- **How they wait off the card — the dump:** already as tensors, in host memory (「Host copies」), each weight in
  the 16 bits it was saved in wherever that holds it exactly, and in 32 bits where it does not — so
  the move back reproduces the card's copy bit for bit. A checkpoint holds about 644 MB of host memory
  that way, eight about 5.2 GB. A move is a memory copy and nothing else: nothing is built. Copying the same checkpoint as one contiguous pinned buffer instead of
  tensor by tensor is no faster (74 against 71 ms on a service node, 463 against 467 ms on a desktop node's RTX
  3080), and from pageable memory or straight from its file it is slower (97 and 139 ms on a service node, 515
  and 528 ms on that 3080); the fifteen to twenty seconds a checkpoint takes at the start are Laya
  building the model and making its first decision, which happens once in the process's life.
- **What a move costs:** putting a checkpoint on the card takes about 56 milliseconds on the service's RTX 4070; taking
  one off takes a hundredth of a second, since only the card's copy is dropped. The card's cache is let go with it, so
  what a large call reserved goes back to the others.
- **Which one goes:** every one outside the next batch, together, which is the ones asked least
  recently that the batch has no room for. A run of calls to gates already in the batch pays no move.
- **When the card has no room** for the checkpoint asked for, every checkpoint is taken off and the
  move tried once more; a second failure answers 503, the gate's LLM decides, and the checkpoint
  waits in host memory for the next call.
- **A decision is never finished on the CPU.** Laya's own answer to a card that runs out
  mid-decision is to move the checkpoint to the processor and decide there, which at a full part takes
  over a minute while every call behind it waits in line. So the server wraps each checkpoint's forward
  pass: a card that runs out there fails the pass before Laya can move, the least recently asked other
  checkpoint is taken off the card, and the same decision is asked again on the card — one checkpoint
  fewer each time, until the asking one is alone there. A decision that still does not fit is answered
  503. Any other failure of the forward pass is answered 500 and is not retried anywhere.
- **The room is made before the pass, where it can be counted.** A pass lays out its questions as one
  block, so its working memory grows with the block's cells, its questions times its padded length,
  above a share every pass takes whatever its size: on the operations machine's 3080 a pass of one question at a
  full state took 258 MiB over the weights, eight 332 MiB and thirty-two 698 MiB.
  - Each pass measures what it took at its peak, kept by the size of its block, in steps of a power of
    two in cells, the most taken in each.
  - A pass is counted at what the smallest step at least its size took, and past the largest step
    measured, at what that one took scaled by its cells.
  - A pass so counted past what the card has free, the allocator's cache counted with it, takes the
    least recently asked others off before it starts, one at a time as a pass that ran out would, so
    it rarely runs out first. Before a pass is measured there is no such count, and it runs as it comes.
- **The room made is lent, not kept.** The number the card holds at once stays what the card takes;
  the checkpoints taken off for a decision go back on as the card is filled once it rests (above), so a
  card with room for every checkpoint holds every one again between decisions. `/health` counts the
  decisions that needed room (`roomMade`).
- **Laya's own fallback to the CPU** anywhere outside the forward pass is undone after the call: the
  checkpoint is put back in host memory and the next call moves it to the card again, so no gate is
  left deciding on the CPU for the rest of the process's life.

## Host copies

`LAYA_HOST_COPY` says how a checkpoint's host copy is kept between its turns on the card; the
installer writes it for the node's machine (`docs/llm-server.md`, 「The engine」).

- **`pinned`** (where nothing sets it): page-locked host memory, held by the process for its whole
  life. It is the fastest way onto a card on a fast link, and the CUDA driver locks it outside the
  account's memlock limit, so the limit does not bound how many checkpoints wait there; nothing else
  on the machine can have that memory while the engine runs.
- **`mapped`:** each checkpoint's host copies written once to a dump file and read back mapped from
  it, so they stand in the page cache, which the kernel may drop under pressure and read again from
  the file. It is for a machine whose memory is a person's desktop first or is shared with other
  services, where pinned copies would hold memory nobody else may have.
  - **A checkpoint on the card holds no mapping:** its dump is mapped for the move onto the card and
    let go once the move is done, so the process keeps nothing of it in host memory while it rests
    there. Taken off, it writes nothing, since the dump already holds what the card held, and is
    mapped again for its next move.
  - The dumps stand in `LAYA_DUMP_DIR`, `~/.cache/bmo-laya/dumps` where nothing sets it, outside the
    installation, one file a checkpoint, named by the checkpoint's folder and a digest of its files'
    names, sizes and times, so a checkpoint replaced under the same name is dumped afresh and the
    stale dump removed.
  - A dump is made from the host copies themselves, never read from the checkpoint's own files, and
    is checked against them when it is read back: one that does not match is made again, so the
    move onto the card reproduces the card's copy bit for bit either way.
- **What each costs on the PCIe 2.0 ×4 link a desktop node's RTX 3080 stood on,** a checkpoint onto the
  card: 467 ms pinned, 515 ms from pageable memory and 528 ms from its file in the page cache; a read
  the kernel had dropped goes to the disk as well. On a 4070 on PCIe 3.0 ×16: 71, 97 and 139 ms.

## Measured on the service's node

Measured on a service node and its RTX 4070 with five checkpoints served, all five on the card.

- **Loading:** 15 to 17 seconds a checkpoint from the local disk, so about a minute and a half for
  the five before the port opens.
- **VRAM:** 7,117 MiB of the card's 12,282 after 128-question calls, all five checkpoints on it — the
  engine's own reserve 6.7 GiB of that. About 5 GiB of the card stays free.
- **Host memory:** the engine holds 6.7 GiB resident — the pinned host copies and torch — and the
  front 80 MB; 47 GiB of the node's 62 stay available.
- **Time per call**, one gate, 50 calls each, p50 / p95 in milliseconds:

  | Questions | Inside the server | From the operations machine, through the front and the tunnel |
  |---|---|---|
  | 1 | 22.7 / 54.0 | 40.1 / 75.1 |
  | 10 | 22.7 / 48.7 | 40.5 / 69.3 |
  | 50 | 62.1 / 72.2 | 75.4 / 85.7 |
  | 100 | 142.8 / 159.8 | 158.0 / 178.4 |
  | 128 | 188.5 / 198.2 | 203.3 / 214.2 |

- **Asking the five gates in turn** costs nothing more, since none of them moves: one question 21.5 /
  25.5 inside and 38.8 / 42.4 from the operations machine, fifty 65.0 / 80.8 and 79.2 / 98.0.
- **The front and the tunnel** add about 15 to 17 milliseconds a call.
- **What it means for the gates:** one question is about 40 ms from the operations machine, fifty about 75 ms and
  128 — the most one call carries — about 200 ms, all of it far under the client's two seconds.
- **The answers are the checkpoint's, to the precision it computes at.** Laya decides under bfloat16
  autocast, so the same checkpoint on another card generation moves a probability in its second or
  third decimal: asked the gates' own recorded inputs, 20 calls a gate, the service's RTX 4070 and a 3080 chose the same
  answer for all 580 questions, with the probabilities at most 0.021 apart. Each card answers the
  same input identically every time.
- **Eight gates, all eight on the card, the gates' own recorded inputs at a full state,** from the operations machine:
  a part of 32 questions takes 0.5 to 0.8 seconds and fits beside the eight checkpoints, the card then
  reading 11,751 MiB of its 12,282. A part of 128 questions at the same state does not fit: it has the
  three least recently asked checkpoints taken off and is answered on the card in 2.8 to 3.0 seconds,
  where Laya's own fallback takes over a minute on the CPU.
- **Eight gates under the card lock,** the unit's settings (every checkpoint pinned, the card let go
  as soon as the last decision in hand ends), one question, from the operations machine:
  - **A decision alone on the card** takes 101 to 125 ms, median 108 over five calls a gate: the
    move onto the card about 56 ms of it, the decision inside the server 85 to 92 ms with the
    checkpoints taken off after it. The same decision with its checkpoint already on the card takes
    37 to 44 ms, so giving the card back after every use costs about 65 ms a decision.
  - **All eight gates asked in turn** take 0.97 seconds, each call paying its move.
  - **Calls that overlap share the card:** eight calls to four gates sent together are answered in
    0.63 seconds, and the card is let go when the last of them ends.
  - **The gates' own test rows,** 20 of each gate, take 129 ms a call at the median against 71 ms on a
    server that keeps checkpoints on the card between calls.
  - **VRAM:** 242 MiB while the card is let go, which is the process's CUDA context alone, and 9,214
    MiB with all eight on the card.
  - **Host memory:** the eight pinned copies take 5.2 GB.
  - **The answers do not move:** 20 test rows of each of the eight gates, 4,421 questions, answered
    the same to the last digit by a server that keeps checkpoints on the card between calls and by
    one that gives the card back after every decision.

## Laya's own recipe

What Laya's maker recommends for training data, training and evaluation, read in its own materials:
the repository's README, `BENCHMARKS.md` and `docs/` (`finetune.md`, `finetune_browser_agent.md`,
`evals.md`, `questions-and-answers.md`), the Kaggle notebook and the script beside it, the releases up
to 0.4.13, the model cards of `laya` and `laya-multilingual`, the dataset card of
`LocalLLaMA/typed-decisions`, and the issues on training (#320, #377, #741, #887, #963). There is no
paper and no wiki. Each point says where this repository stands against it.

- **The gold is a teacher's distribution.** A row's answer is the probability the teacher gave each
  option, and both halves of the loss read it. The benchmark's data is labelled three times by its
  teacher at temperature 0.7, the gold being the mean of the three, so it stays soft where the
  teacher is in two minds; a fresh sample against the other two agrees 0.735 of the time, which is
  the most a student can be read to reach. Which teacher, and how many samples, the materials leave
  open.
  - Here: a per-candidate gate's judged labels are one judgement mapped to 0.95 or 0.05 (0.5 for
    `related`); the knowledge gate's distilled work labels are three samples of the teacher's own
    probability, averaged. The claude road
    cannot set a temperature, so each sample is a call of its own.
- **A dataset is audited before it is used:** the states are varied, the answers balanced, and the
  gold follows the input.
- **No class weight or sampler is offered for a rare answer.** The worked example of a browser agent
  repeats its rare operations three and four times and keeps everything else; `--label-smoothing`
  moves a share of each answer's weight to the others.
  - Here: the common answer is dropped to three times the rarer, question by question and within a
    row's kind of input, because repetition left this repository's per-candidate gates answering no
    (below); the knowledge gate's distilled work, whose yes answers are plentiful, is dropped only
    to eight times.
- **A run is sized in optimizer updates**, `epochs × ceil(ceil(items / micro-batch) / accumulation)`.
  The benchmark's default run spends 352; a small set at four epochs spends far fewer and can
  collapse to the answer it sees most (#963), so a small set is given more epochs, and a run is
  repeated over several seeds, since leaving the plateau is seed-dependent. A run that stays at the
  prior is diagnosed with a positive control: the answer spelled in a tag on every text, which a
  sound run learns perfectly.
  - Here: four epochs for every gate, three seeds for a gate put in service, and the update count of
    each run in its `train_meta.json`.
- **The loop** is RLCD — policy gradients over noised logits rewarded by proper scoring rules, plus
  soft cross-entropy, both against the gold distribution — at 4 epochs, an effective batch of 64,
  AdamW 2.5e-5 and 1e-4 with a weight decay of 0.01, a cosine schedule and a clip of 1.0. The
  package's loop offers soft cross-entropy alone as `soft-ce`, which an open issue (#741) measured as
  good or better on the benchmark; its default is RLCD.
  - Here: the same loop and settings, RLCD included, at micro-batch 4 and bf16 (below).
- **The loop ships in the package** (`laya.train`, `laya-train`).
  - Here: laya is pinned at 0.4.13. The loop is this repository's own `finetune.py` and `calibrate.py`,
    which reproduce the package's figures on its benchmark (below) and carry what the package's loop
    has no part of: the resume, the giving way on the card and the balance per question. A question
    is made into a training item by the package's own functions, so it is rendered as inference
    renders it.
- **The budgets are the checkpoint's own:** `laya-multilingual` reads 1,024 tokens per question,
  256 of them for the question and its options, as its configuration says, and a run writes the
  budgets it trained at into the configuration it saves.
  - Here: the same, read from the configuration of the checkpoint a run starts from.
- **A question whose options do not fit is left out,** not trained on: `options_collapsed` where the
  question's budget cuts two options to the same tokens or leaves one without its marker, and
  `options_beyond_max_len` where the question runs past the whole budget, so the state has no room
  and the last options lose their markers. A question that is not well formed is left out as
  `invalid_question`, and one whose gold does not fit its options as `invalid_target`.
  - Here: the same reasons, counted in the training's output and its `train_meta.json`, and in what
    the calibration prints.
- **Calibration** fits one temperature per question type, and one per question type and option
  count where a bucket holds enough, by LBFGS on a held-out slice (400 items or a tenth), held to
  [0.5, 5.0], the range the loader applies. The per-option-count temperatures a checkpoint carries
  are removed before the fitted ones are written, since an inherited one would mask the fit: the
  loader reads a bucket's temperature before its type's. `laya-multilingual` ships uncalibrated.
  - Here: one temperature per question type and option count, fitted on the calibration split with
    the package's own fitter and range, the type's as the fallback; a checkpoint's inherited
    per-option-count temperatures are dropped before the fitted ones go in.
- **Evaluation** is held out from training and calibration, and reads accuracy, Brier and ECE side by
  side, sliced by what matters (a language, a workflow); a gate's threshold is read on the answer's
  own confidence after calibration.
  - Here: plain and balanced agreement, yes recall and ECE on the test split, over three seeds.
- **A yes/no question returns the probability of yes, and can follow its option labels rather than
  the state,** most of all on the English checkpoint; a yes/no with no criteria renders one generic
  pair of options for every state, and criteria are advised where it must discriminate.
  - Here: a per-candidate gate's questions are the gate's own, a yes/no with instructions and no criteria, on the
    multilingual checkpoint.

## The training loop and calibration

`laya-multilingual` out of the box judges mixed decisions at chance and is over-confident, so it is
trained before it is believed. What it is trained on is the distilled data this repository builds —
`docs/gate-data.md` for the rows and the judging, `docs/laya-gates.md` for what each gate's rows must
answer to. The training loop is this repository's own `finetune.py`, a single-GPU adaptation of the
official notebook (`laya_finetune_typed_decisions_2xT4_kaggle.ipynb`). The notebook's own
`train_ddp.py` shards one model across two T4s under DDP and this repository does not carry it: every
run here trains one gate's model on a card of its own, so there is nothing for DDP to shard, and
`finetune.py` is launched directly — no `torchrun` and no process group.

- **It trains as the manufacturer's recipe does.** Measured on 10 October 2026 on a training node's RTX 4070 on
  the manufacturer's own benchmark (`LocalLLaMA/typed-decisions`, 2,000 test decisions), with the
  package's own loop (`laya.train`, laya 0.4.1) beside `finetune.py`: from the English checkpoint
  0.775 against 0.7765, where the manufacturer publishes 0.766 and 0.7715; from the multilingual
  checkpoint 0.757 and 0.749 against 0.7485 and 0.7425 over two seeds each. The two base checkpoints
  score 0.3595 and 0.3505 untrained, as published (0.362 and 0.3515).

1. **Merge** the gates' frozen folders into the one dataset a training reads: `train.jsonl`,
   `calibration.jsonl` and `test.jsonl` in the notebook's row format — `id`, `gate`, `split`, and
   `state`, `questions` and `gold` each as a JSON string, the gold of a yes/no being its `true` and
   `false` probabilities and that of a choice one probability per option. Training is what the model
   learns from, calibration is what the temperatures are fitted on and is never trained on, and test
   is what the figures are measured on and is neither; a row's split is fixed by its input hash, so
   one input never sits in two and keeps its split as the data grows.
2. **Carry it to a node** the way the node unit's node list reaches it, into `~/bmo-laya/data/<name>/`. The training scripts are
   uploaded with the data by the setup verb.
3. **Train** with `.venv/bin/python finetune.py --data data/<name> --out checkpoints/<name>`:
   - The loop is the notebook's — RLCD policy gradients over noised logits with a proper scoring
     reward, plus soft cross-entropy, both against the gold distribution — with its settings: 4
     epochs, an effective batch of 64, GRPO groups of 4, a cosine schedule, encoder learning rate
     2.5e-5 and head learning rate 1e-4, AdamW with a weight decay of 0.01, and gradients clipped to
     a norm of 1.0.
   - **Every question is made an item as the package makes it** (`laya.train`): rendered as inference
     renders it, its row's state tokenised once for all its questions, at the budgets of the
     checkpoint it starts from — 1,024 tokens, 256 of them for the question and its options, on
     `laya-multilingual`. A question that cannot be trained on is left out under the package's
     reason (「Laya's own recipe」), and how many were left out for each reason is printed with the
     items and written into `train_meta.json`.
   - **The run settings are fixed:** micro-batches of 4 accumulated to an effective 64, bf16 and
     gradient checkpointing, on one GPU. They are the same for every gate, and a card with room to
     spare is not a reason to raise them — four is the only micro-batch measured where no seed
     collapsed to one answer (「What the savings cost」), and that, not memory, is why it stands.
   - **Two savings can be asked for and neither is used:** `--freeze-embeddings` leaves the 256k × 768
     token embeddings untrained and `--optimizer adamw8bit` keeps the optimizer state in 8 bits. Both
     cost accuracy at these settings, so neither is turned on (「What the savings cost」).
   - It starts from the hub's multilingual checkpoint unless `--base` names another.
   - **Balance:** within each question a gate asks, no answer is kept more than three times as often
     as that question's rarest (`--balance-ratio`). A per-candidate gate answers no to almost every
     candidate, and unbalanced data teaches Laya to answer no always, which agrees with it as often
     as a real judgement and decides nothing.
   - **The balance is counted per question, never over the whole gate.** A per-candidate gate's questions
     are its candidates, each with a rate of its own. Counted over the gate, the few candidates that
     carry most of its yes answers keep every yes and lose nearly every no, and are taught to say yes
     to every turn — the system reference `structure`, at a fifth of its turns needed, becomes
     nine-tenths yes. Counted per question, each candidate is held to its own ratio and no more. A
     gate that asks one question is balanced the same either way.
   - **A row that names its kind of input is balanced within that kind.** A row may say which kind of
     input its state is (its `stratum`), and its questions are then counted as questions of that kind
     alone: the knowledge gate's piece asked over a job's request is one question, the same piece
     asked over a conversation turn another. A piece needed on turns far more often than on work
     otherwise keeps its no answers out of every kind alike, and work, whose yes answers are the
     scarcer, is taught that its inputs are almost never yes. A row naming no kind is counted as
     before.
   - **A kind can be held to a ratio of its own** with `--kind-ratio <kind>=<n>`, which `laya-train.ts`
     passes on. Three to one teaches every question a rate of a quarter whatever its own rate, which
     a kind whose yes answers are scarce needs and a kind whose yes answers are plentiful does not:
     there it lifts a piece needed one time in eight or twenty to one in four.
   - **A training on the knowledge gate's distilled folder takes `--kind-ratio work=8`.** Measured on 12 October 2026 on a training node's
     RTX 4070 over its distilled rows, seed 1234:
     at three to one for work too, the 28 hand-written work requests drew 17 pieces not needed where
     the checkpoint then serving drew 2, nearly all of them the research rule on every search; at
     eight to one they drew none. Over three seeds at eight to one the balanced agreement on the test
     split was 0.614, 0.649 and 0.677 against that checkpoint's 0.612, and the seeds differed most in
     how many pieces they attached at all, so the one put in service is the seed that cleared every
     bar.
   - **The questions only ever given one answer** — the lore piece no turn needed — have nothing to
     balance against. Together they keep at most three times the gate's rarest answer, shared evenly
     among them, so a library of pieces nobody needs does not bury the few that are.
   - **The manufacturer's way with a rare answer can be asked for instead:** `--repeat-cap <n>` keeps
     every sequence and repeats each question's rarer answers toward the same ratio, at most `n`
     times over, as Laya's own worked example re-weights its rare operations three and four times
     rather than dropping the common ones. It is counted per question for the same reason, the cap
     keeps a candidate with two yes answers in thousands from being taught those two sentences a
     thousand times, and a question only ever given one answer is kept as it stands.
   - **Dropping the common answer stays the default** for a per-candidate gate. Measured on 10 October 2026
     on a training node's RTX 4070 over the knowledge gate's rows (4,468 training rows, one yes in two hundred),
     repeating the rarer answers four times, and repeating them toward three to one at most fifty
     times, each left the checkpoint answering no to 49 or 50 of the test split's 50 needed questions,
     where dropping found 13: kept whole, the gate's questions that are never yes outweigh any
     repetition the cap allows.
   - `--per-gate` also caps how many sequences one gate gives.
   - It writes a new directory, a rolling checkpoint the run can be resumed from, and
     `train_meta.json` with the sequences per gate, the questions left out by reason, each epoch's
     time and loss, and the peak memory. Its configuration keeps the base's temperature per question
     type and none per option count, since the base's were fitted to other weights.
     It never writes over a directory that exists, and `--resume` is how a killed run carries on from
     what it saved rather than starting again (`docs/training.md`, 「The resume contract」).
   - **Memory:** training alone reserves about 6.8 GB on a 4070, which never comes near its 12 GB, and
     6.32 GiB on an 8 GB 3060 Ti, 6,654 MiB of the card as `nvidia-smi`
     reads the process, which leaves room beside the services' idle contexts and none for anything else.
4. **Calibrate** with `.venv/bin/python calibrate.py --model checkpoints/<name> --data data/<name>`:
   - It fits one temperature per question type and option count — the buckets Laya's runtime reads —
     by LBFGS on the calibration split, with one per type as the fallback for a bucket of fewer than
     ten questions. The fit is the package's own (`laya.calibrate`), each option count fitted within
     its own width, and every temperature is held to [0.5, 5.0], the range the runtime applies at load.
   - `--write` puts them into the checkpoint's own configuration, the per-option-count temperatures it
     carried removed first, so a bucket the fit leaves out falls back to its type's fitted temperature
     and never to one inherited from another fit.
   - The splits' questions are made items as the training makes them, and what it prints counts the
     questions of each split left out, by reason.
5. **Compare** before and after, on the test split — neither trained on nor fitted on: `calibrate.py`
   prints, overall and per gate, the calibration error and the agreement with the teacher's verdicts,
   plain and **balanced** — averaged over the answers the teacher gave, so a model that always gives a
   gate's common answer scores a half on a yes/no however high its plain agreement. Run it on the hub
   checkpoint without `--write` for the base. Temperature scaling never moves an argmax, so it is the
   calibration error the fit changes and not the agreement.
6. **Try it without putting it in service:** the server's loader can be pointed at the checkpoint in a
   process of its own (`LAYA_CHECKPOINTS=<gate>=<dir>` with `server.load_decider()`), which loads it
   and makes one decision while the unit goes on serving what it serves. **Asking a checkpoint
   outside the service** about many inputs is `predict.py --model <dir> --rows <rows.jsonl> --out
   <answers.jsonl>` on a training node: each row's state and questions go through the same predict
   call the server makes, under the checkpoint's own temperatures, and each row comes back as one
   line — its id, gate and turn, and every question's probability of yes. `--card-lock <path>` holds the
   node's card as a turn that gives way, as a calibration does; `--device cpu` asks it on the node's
   processor instead, which takes no card and is many times slower. Two checkpoints asked about
   the same rows are set side by side question by question, which is how a slice of the test — the
   short turns, one room — is compared before either is put in service.
7. **Put it in service** with `bun scripts/laya-serve.ts <training gate>/<run>/step-<n> --gate <gate>`,
   which carries the collected checkpoint to every service node in the same layout, names it for its gate in
   `LAYA_CHECKPOINTS` (「Which checkpoint answers which gate」) and restarts the unit. `/health` then
   names it. Moving a gate off `shadow` and its τ are the gate's options, chosen by the owner.

- **Any Linux host with a CUDA GPU and Python 3.10 or later** runs the same scripts in the same venv;
  the training machines are the nodes the training placement names (`docs/training.md`, 「The nodes」).

## Training on the nodes

- **The machines:** the nodes the training placement names (`docs/training.md`, 「The nodes」),
  read off each node rather than stated here. Today that is the operations machine alone, the service's own
  node, where a run gives the card back to the services whenever they ask (`docs/llm-server.md`,
  「Training on a service node」).
- **The venv stands on uv's own Python, never on the system's.** torch's native Triton kernels are
  compiled on the node at the first step against the interpreter's development headers, and uv's
  interpreter carries its own while the system's are installed on one node and missing on the next.
  A venv found standing on the system Python is reported as not ready and is made again.
- **Each is reached as the node unit's node list says** (`docs/llm-server.md`, 「The placement」): an ssh node
  by a batch login, a console node through its hub by the node console the tooling's settings name,
  whose `exec -a <node> '<command>'` runs a command and
  `upload` / `download` carry a file across.
- **Every call to a node is bounded by a clock, and one that outlives it is killed.** A transfer is
  given a minute plus a second for every megabyte it carries — twenty times slower than the tunnel
  has ever carried a file — and a command six minutes, one more than the hub itself streams one for.
  A call that stood silent past that would otherwise hold whatever waits on it for as long as nobody
  noticed. The fault it leaves says the limit and the bytes: the file's size for a transfer, what the
  command had answered for a command.
- **A failed call says why.** Its fault carries the exit code and the tail of what the console wrote
  to stderr, or to stdout where stderr was empty, and says so where it wrote nothing at all.
- **A transfer that failed is made once more** before its caller hears of it, since most of what
  breaks one is the tunnel of the moment. A second failure is the caller's to handle, and says that
  it was the second.
- **What a node carries is read off the node, not from here.** The GPU, the free VRAM, the CUDA and
  python versions and the installed package versions move with the machine, so the setup verb reports
  the nodes side by side rather than this document stating them (`docs/training.md`).
- **What is put there:** `~/bmo-laya` in the node's own account — `finetune.py`, `calibrate.py`,
  `compare.py`, `predict.py`, the resume bookkeeping they share and `pyproject.toml`, a uv venv built from it with
  `laya` pinned, and the dataset folders under `data/`. No server, no unit and no token: a node
  trains, and the deciding stays on the service's node. On a node that is both, the training files
  stand beside the service's in the same folder and run on the same venv. `uv pip install -r pyproject.toml --extra savings` adds
  bitsandbytes, which only the 8-bit optimizer run needs.
- **A run is detached with `setsid`.** The hub stops a command it is streaming after five minutes, and
  the stop reaches the whole process group, so a run started with `nohup` alone dies with it. What
  survives is `setsid nohup … &` with its output redirected to a log the next console `exec` reads.
- **Measured on one node, fixed settings, 4 epochs over 1,303 sequences:** about 34 seconds an epoch,
  139 seconds in all, 6.79 GB of the card reserved at peak (6.7 GiB as `nvidia-smi` reads it, the
  CUDA context included). That is 5 GB short of the card, so **no offload is used and none is
  needed**; the search that weighed ZeRO-2 and FSDP offload against the savings below is answered by
  the measurement.
- **What the training run holds** is almost all weights, gradients and optimizer state. Gradient
  checkpointing leaves the activations so small that halving the micro-batch moves the peak by
  0.02 GB, while freezing the embeddings takes 2.4 GB off it.

## What the savings cost

`compare.py --data <folder> --out <folder>` trains the fixed settings and each saving beside it, three
seeds each, and calibrates and measures every one the same way. The figures below are a whole
dataset of every gate — 1,303 training sequences, 1,847 test questions — as the balanced
agreement on the test split, seed by seed. **This is the side-by-side measurement a saving has to
pass, it is settled, and it is not run again per gate.**

| Run | Peak reserved | 4 epochs | Balanced, per seed | Plain agreement | ECE |
|---|---|---|---|---|---|
| Plain, micro-batch 8 | 6.83 GB | 106 s | 0.798 · 0.817 · 0.475 | 0.927 | 0.036 |
| Embeddings frozen | 4.44 GB | 100 s | 0.807 · 0.811 · 0.486 | 0.926 | 0.035 |
| AdamW 8-bit | 4.91 GB | 102 s | 0.473 · 0.811 · 0.487 | 0.927 | 0.033 |
| Both | 3.73 GB | 98 s | 0.805 · 0.824 · 0.489 | 0.926 | 0.035 |
| Micro-batch 4 | 6.82 GB | 148 s | 0.828 · 0.840 · 0.812 | 0.926 | 0.047 |

- **No saving is used and none is to be turned on.** An option that lowers quality is not touched: a
  setting whose figures fall is not weighed against the memory it would save. The card
  has 5 GB to spare at the fixed settings, so there is nothing to buy with one.
- **What the table settles is the run configuration:** micro-batch 4, an effective batch of 64, bf16
  and gradient checkpointing, the same for every gate and every node.
- **The one thing left for a card that runs short is offload** — DeepSpeed ZeRO-2 optimizer offload,
  and nothing before it: not the two savings, and not a smaller batch either, since the settings are
  fixed and a card that runs short takes offload alone. It is not built and not installed,

  because the measured peak is 5 GB short of the card. A measured peak that comes near the 12 GB is
  what would call for it, and no run has produced one.
- **What the seeds say.** A seed in four collapses to the common answer of the biggest gate — a
  balanced figure near 0.48, which is what always answering the same thing scores — under the plain
  settings and under every saving alike. Micro-batch 4 was the one setting where no seed collapsed,
  and it is what `finetune.py` runs by default.
- **A checkpoint is never judged on one run.** Three seeds, and the balanced figure rather than the
  plain agreement, is what says whether a training worked.
- **Each gate is served by a seed of its own.** Its seeds are measured against the gate's bars and
  the one that clears every bar is put in service; no bar asks every seed to clear it, and no gate
  takes another's seed. The seed each gate is served by stands beside its checkpoint in 「Which
  checkpoint answers which gate」.

## One gate to a node

- **Each gate is its own training run**, and a run takes a card to itself, giving it back to the
  services on a node that is theirs too. One gate goes to one node and as many run at once as there are
  nodes, and each node takes the next gate of `docs/laya-gates.md` as its own finishes.
- **The run across the nodes has a document of its own** — `docs/training.md`: what a checkpoint
  carries and how a killed run is resumed from it, how the gates are assigned and what the run ledger
  records, where the checkpoints are collected, and the two tables the run is judged on.
