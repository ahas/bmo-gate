# The Laya server and the training behind it

Laya is a small open decision model (`laya-multilingual`, 322M, Apache 2.0) that answers a yes/no or
multiple-choice question about a piece of text with calibrated probabilities. It stands on its own as
an installed provider: this repository holds the server, the data the checkpoints are trained on and
the training itself, and BMO holds only the client that asks it and the configuration of which gate
asks (BMO's `docs/laya.md`).

## The server

- **Where it runs:** node `n6` (BMO's `docs/nodes.md`), as the engine of the Laya service there — the
  systemd user unit `bmo-llm-laya.service`, behind the service's MCP and OpenAI-compatible front and
  the tunnel that brings it to main-host (`docs/llm-server.md`). Linger is on for the account, so the
  unit starts with the machine, with nobody logged in.
- **What it is:** the small HTTP server kept in this repository under `laya-server/`, in `~/bmo-laya`
  on its own Python 3.12 virtual environment, built by `uv` in user space on uv's own interpreter —
  the same venv a training node's setup builds. The service's installer, `bun scripts/llm-install.ts`,
  is the one way it is put there or updated, and it installs no system package and asks for no sudo.
- **What it compiles:** torch's native Triton kernels are built against the venv's Python the first
  time a decision meets an input shape, with the node's C compiler and the headers uv's interpreter
  carries. A kernel is built once for each of the few shapes the input padding leaves, costs 40 to 120
  milliseconds the once, and is kept in the account's triton cache on disk, so it survives a restart
  and the shapes a gate asks are warm within a handful of calls.
- **What it holds:** one checkpoint per gate, never one shared by all of them. On start it loads
  every checkpoint the unit's settings name (「Which checkpoint answers which gate」), one after the
  other, and each makes one decision of its own on the card before the next is loaded. Only then does
  it open the port, so a server that answers `/health` can decide for every gate it names, and one
  whose checkpoint cannot decide stops and is restarted by the unit. It never falls back to the hub
  model: a gate no checkpoint is named for is refused, not answered by another gate's checkpoint.
- **Its environment:**
  - `USE_TF=0`, which the model card names as the cure for a load that hangs.
  - torch comes as PyPI's default build (CUDA 13), which n6's driver runs.
- **While it loads** (about fifteen seconds a checkpoint from the local disk, 「Measured on n6」), the
  port does not answer at all; the front answers a call meanwhile with 503.
- **Port:** `7431` on n6's loopback alone. The front is the only way to it.
- **One call carries at most 128 questions**; more is refused as a request it cannot read.
- **Its two calls:**
  - `GET /health` — for each gate it serves, the checkpoint directory, whether it is on the card now,
    how long it took to load and the calibration temperatures it carries; beside those the device,
    the VRAM the process holds, how many checkpoints may be on the card at once, how many decisions
    ran out of card and were asked again with room made (`roomMade`), how many calls were dropped
    because their caller had left (`droppedCalls`), and the Laya and torch versions. Its `model` line
    names every gate with its checkpoint, so a change of any one of them is a change of the model a
    watcher sees.
  - `POST /decide` — the gate asking, a state and a set of named questions in, Laya's answer for each
    question out, as that gate's checkpoint gives it: the probabilities, the chosen option and the
    confidence. A call that names no gate is refused as a request it cannot read (400); one that names
    a gate no checkpoint serves is refused as not served here (404); one whose checkpoint cannot be put
    on the card because something else holds it is answered 503, and none of them is asked of a
    checkpoint. A decision that does not fit on the card even with its checkpoint alone there is
    answered 503 too (「Sharing the card」).
- **One decision at a time.** Calls wait in line for the card. A call whose caller has hung up by the
  time its turn comes — the front gave up on it — is dropped unasked, with one log line and no answer,
  so calls nobody waits for any more never hold up the ones behind them. An answer whose caller left
  while it was being made is dropped the same way.
- **Token:** every call carries a bearer token, the Laya service's one key (`docs/llm-server.md`,
  「The key」), which the server reads as `LAYA_TOKEN` from the service's environment file on n6. The
  token never goes into the archive, a log, a command line or the console.
- **Installing and updating:** `bun scripts/llm-install.ts` from this checkout on main-host, which puts
  up the whole service on n6 (`docs/llm-server.md`, 「Installing and updating」). The gates' settings
  file, `~/.config/bmo-laya/env`, is made once naming no gate and is never overwritten.
- **Restarting it:** through the jake console, `exec -a n6 'systemctl --user restart bmo-llm-laya'`;
  `journalctl --user -u bmo-llm-laya` there holds its log, one line per call and no request body.
- **Timing a call:** `laya-server/bench.py --gates <gate>[,<gate>…]` asks the server with 1, 10 and 50
  questions on a Korean state, from main-host through the service's front with `--url
  http://127.0.0.1:18010`. Given two gates it asks them in turn, which times the move between the card
  and host memory as well as the decision where one is made.

## Which checkpoint answers which gate

- **One place says it:** `LAYA_CHECKPOINTS` in the gates' settings file on n6,
  `~/.config/bmo-laya/env` — `gate=directory` pairs separated by spaces, the whole value in double
  quotes. A directory that is not absolute is read from `~/bmo-laya`, where the checkpoints are kept
  in the layout the collection keeps them in on main-host: `checkpoints/<training gate>/<run>/step-<n>`.
  The gate on the left is the name BMO asks with, which is the gate's own key in BMO.
- **What decides the gate on the left is BMO's key, and the directory on the right is the training
  side's name.** Most of the two agree. Where they do not, the settings file is the one place that
  joins them:

  | Training gate (`docs/laya-gates.md`) | BMO gate asking | Checkpoint |
  |---|---|---|
  | `output-format` | `output-format` — the gate whose provider is Laya, asked the reduced state | served (`real-2-fold`) |
  | `output-format` | `output-decide` — a BMO build older than its one formatting gate, asking the original, the converted message and the fold | served (`real-1-hand`) until no running BMO asks it |
  | `library-knowledge` | `library-knowledge` | served |
  | `room-rules` | `room-rules` | served |
  | `situation-rules` | `situation-rules` | served |
  | `system-documents` | `system-documents` | served (`real-1-hand2`); below the bar on real turns (`docs/reference-data.md`) |
  | `people-search` | `people-search` | none trained yet, refused |
  | `content-judge` | `content-judge` | not served: the gate's mode is `off`, and its trained checkpoint answers a question the gate no longer asks (`docs/gate-data.md`, 「A gate whose question moved」) |
  | `reply-wanted` | none — no gate code in BMO | trained, not served |
  | `sanitizer` | `sanitizer` | not trained |

- **A checkpoint answers only the shape it was trained on.** The state a gate's probe sends must be
  the state its training rows carry, to the character. A checkpoint asked in another shape still
  answers, and answers the common answer to everything — a figure that looks like 0.8 agreement and
  is only the base rate. So the `output-format` reduction is written out in `docs/laya-gates.md` and
  BMO builds it from the same markdown with the same fixture under test.
- **Changing a gate's checkpoint** is `bun scripts/laya-serve.ts <training gate>/<run>/step-<n>
  --gate <gate>`, which carries the checkpoint to n6, names it there and restarts the unit
  (`docs/llm-server.md`, 「Putting a checkpoint in service」).

## Sharing the card

A card the server does not hold alone can keep only some of the checkpoints on it at once and let the
rest wait in host memory. n6's card is the server's alone, so the service lets every checkpoint onto
it for as long as the decisions leave them room (`docs/llm-server.md`, 「The engine」); what follows
is the mechanism.

- **What a checkpoint costs on the card:** 1.2 to 1.4 GB each as `nvidia-smi` reads it — the weights
  are kept in 32 bits there, as Laya builds them. A decision needs working memory of its own beside
  them, which grows with the tokens it lays out, so the card that holds every checkpoint of eight
  gates has no room left for a large part.
- **How many are on the card at once** is `LAYA_CARD_MODELS` (1 where nothing sets it) at most, fewer
  once a decision has needed the room (below), and the others wait in host memory. That is offload
  and nothing else: a checkpoint's weights are the same numbers
  wherever they wait, and its answers are the same to the last digit after any number of moves,
  measured on four checkpoints over three rounds each.
- **How they wait:** in pinned host memory, each weight in the 16 bits it was saved in wherever that
  holds it exactly, and in 32 bits where it does not — so the move back reproduces the card's copy
  bit for bit. Four checkpoints hold about 2.6 GB of host memory that way.
- **What a move costs:** putting a checkpoint on the card takes about half a second; taking one off
  takes a hundredth, since only the card's copy is dropped. The card's cache is let go with it, so
  what a large call reserved goes back to the others.
- **Which one goes:** the one asked least recently. A turn that asks two served gates pays one move
  each; a run of calls to one gate pays none.
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
- **The card keeps the room it has had to make.** Once a decision has fitted only after checkpoints
  were taken off, the number the card holds at once is lowered to what stood on it when it fitted, for
  the rest of the process's life, so the next decision of that size finds its room without failing
  first. `/health` says the number it stands at; a restart starts again from `LAYA_CARD_MODELS`.
- **Laya's own fallback to the CPU** anywhere outside the forward pass is undone after the call: the
  checkpoint is put back in host memory and the next call moves it to the card again, so no gate is
  left deciding on the CPU for the rest of the process's life.

## Measured on n6

Five gates served (`output-decide`, `library-knowledge`, `room-rules`, `situation-rules`,
`system-documents`), all five on the card.

- **Loading:** 15 to 17 seconds a checkpoint from the local disk, so about a minute and a half for
  the five before the port opens.
- **VRAM:** 7,117 MiB of the card's 12,282 after 128-question calls, all five checkpoints on it — the
  engine's own reserve 6.7 GiB of that. About 5 GiB of the card stays free.
- **Host memory:** the engine holds 6.7 GiB resident — the pinned host copies and torch — and the
  front 80 MB; 47 GiB of n6's 62 stay available.
- **Time per call**, one gate, 50 calls each, p50 / p95 in milliseconds:

  | Questions | Inside the server | From main-host, through the front and the tunnel |
  |---|---|---|
  | 1 | 22.7 / 54.0 | 40.1 / 75.1 |
  | 10 | 22.7 / 48.7 | 40.5 / 69.3 |
  | 50 | 62.1 / 72.2 | 75.4 / 85.7 |
  | 100 | 142.8 / 159.8 | 158.0 / 178.4 |
  | 128 | 188.5 / 198.2 | 203.3 / 214.2 |

- **Asking the five gates in turn** costs nothing more, since none of them moves: one question 21.5 /
  25.5 inside and 38.8 / 42.4 from main-host, fifty 65.0 / 80.8 and 79.2 / 98.0.
- **The front and the tunnel** add about 15 to 17 milliseconds a call.
- **What it means for the gates:** one question is about 40 ms from main-host, fifty about 75 ms and
  128 — the most one call carries — about 200 ms, all of it far under the client's two seconds.
- **The answers are the checkpoint's, to the precision it computes at.** Laya decides under bfloat16
  autocast, so the same checkpoint on another card generation moves a probability in its second or
  third decimal: asked BMO's own recorded inputs, 20 calls a gate, n6 and a 3080 chose the same
  answer for all 580 questions, with the probabilities at most 0.021 apart. Each card answers the
  same input identically every time.
- **Eight gates, all eight on the card, BMO's own recorded inputs at a full state,** from main-host:
  a part of 32 questions takes 0.5 to 0.8 seconds and fits beside the eight checkpoints, the card then
  reading 11,751 MiB of its 12,282. A part of 128 questions at the same state does not fit: it has the
  three least recently asked checkpoints taken off and is answered on the card in 2.8 to 3.0 seconds,
  where Laya's own fallback takes over a minute on the CPU.

## The training loop and calibration

`laya-multilingual` out of the box judges mixed decisions at chance and is over-confident, so it is
trained before it is believed. What it is trained on is the distilled data this repository builds —
`docs/gate-data.md` for the rows and the judging, `docs/laya-gates.md` for what each gate's rows must
answer to. The training loop is this repository's own `finetune.py`, a single-GPU adaptation of the
official notebook (`laya_finetune_typed_decisions_2xT4_kaggle.ipynb`). The notebook's own
`train_ddp.py` shards one model across two T4s under DDP and this repository does not carry it: every
run here trains one gate's model on a card of its own, so there is nothing for DDP to shard, and
`finetune.py` is launched directly — no `torchrun` and no process group.

1. **Merge** the gates' frozen folders into the one dataset a training reads: `train.jsonl`,
   `calibration.jsonl` and `test.jsonl` in the notebook's row format — `id`, `gate`, `split`, and
   `state`, `questions` and `gold` each as a JSON string, the gold of a yes/no being its `true` and
   `false` probabilities and that of a choice one probability per option. Training is what the model
   learns from, calibration is what the temperatures are fitted on and is never trained on, and test
   is what the figures are measured on and is neither; a row's split is fixed by its input hash, so
   one input never sits in two and keeps its split as the data grows.
2. **Carry it to a node** with `jake upload`, into `~/bmo-laya/data/<name>/`. The training scripts are
   uploaded with the data by the setup verb.
3. **Train** with `.venv/bin/python finetune.py --data data/<name> --out checkpoints/<name>`:
   - The loop is the notebook's — RLCD policy gradients over noised logits with a proper scoring
     reward, plus soft cross-entropy — with its settings: 4 epochs, an effective batch of 64, GRPO
     groups of 4, a cosine schedule, encoder learning rate 2.5e-5 and head learning rate 1e-4.
   - **The run settings are fixed:** micro-batches of 4 accumulated to an effective 64, bf16 and
     gradient checkpointing, on one GPU. They are the same for every gate, and a card with room to
     spare is not a reason to raise them — four is the only micro-batch measured where no seed
     collapsed to one answer (「What the savings cost」), and that, not memory, is why it stands.
   - **Two savings can be asked for and neither is used:** `--freeze-embeddings` leaves the 256k × 768
     token embeddings untrained and `--optimizer adamw8bit` keeps the optimizer state in 8 bits. Both
     cost accuracy at these settings, so neither is turned on (「What the savings cost」).
   - It starts from the hub's multilingual checkpoint unless `--base` names another.
   - **Balance:** within each question a gate asks, no answer is kept more than three times as often
     as that question's rarest (`--balance-ratio`). A reference gate answers no to almost every
     candidate, and unbalanced data teaches Laya to answer no always, which agrees with it as often
     as a real judgement and decides nothing.
   - **The balance is counted per question, never over the whole gate.** A reference gate's questions
     are its candidates, each with a rate of its own. Counted over the gate, the few candidates that
     carry most of its yes answers keep every yes and lose nearly every no, and are taught to say yes
     to every turn — the system reference `structure`, at a fifth of its turns needed, becomes
     nine-tenths yes. Counted per question, each candidate is held to its own ratio and no more. A
     gate that asks one question is balanced the same either way.
   - **The questions only ever given one answer** — the lore piece no turn needed — have nothing to
     balance against. Together they keep at most three times the gate's rarest answer, shared evenly
     among them, so a library of pieces nobody needs does not bury the few that are.
   - `--per-gate` also caps how many sequences one gate gives.
   - It writes a new directory, a rolling checkpoint the run can be resumed from, and
     `train_meta.json` with the sequences per gate, each epoch's time and loss, and the peak memory.
     It never writes over a directory that exists, and `--resume` is how a killed run carries on from
     what it saved rather than starting again (`docs/training.md`, 「The resume contract」).
   - **Memory:** training alone reserves about 6.8 GB. A training node's 4070 has the card to itself
     and never comes near its 12 GB.
4. **Calibrate** with `.venv/bin/python calibrate.py --model checkpoints/<name> --data data/<name>`:
   - It fits one temperature per question type and option count — the buckets Laya's runtime reads —
     by LBFGS on the calibration split, with one per type as the fallback for a bucket of fewer than
     ten questions, held to the range the runtime applies.
   - `--write` puts them into the checkpoint's own configuration.
5. **Compare** before and after, on the test split — neither trained on nor fitted on: `calibrate.py`
   prints, overall and per gate, the calibration error and the agreement with the teacher's verdicts,
   plain and **balanced** — averaged over the answers the teacher gave, so a model that always gives a
   gate's common answer scores a half on a yes/no however high its plain agreement. Run it on the hub
   checkpoint without `--write` for the base. Temperature scaling never moves an argmax, so it is the
   calibration error the fit changes and not the agreement.
6. **Try it without putting it in service:** the server's loader can be pointed at the checkpoint in a
   process of its own (`LAYA_CHECKPOINTS=<gate>=<dir>` with `server.load_decider()`), which loads it
   and makes one decision while the unit goes on serving what it serves.
7. **Put it in service** with `bun scripts/laya-serve.ts <training gate>/<run>/step-<n> --gate <gate>`,
   which carries the collected checkpoint to n6 in the same layout, names it for its gate in
   `LAYA_CHECKPOINTS` (「Which checkpoint answers which gate」) and restarts the unit. `/health` then
   names it. Moving a gate off `shadow` and its τ are BMO's settings, chosen by 하스.

- **Any Linux host with a CUDA GPU and Python 3.10 or later** runs the same scripts in the same venv;
  the training machines are n2 to n5.

## Training on the nodes

- **The machines:** nodes `n2` to `n5` (BMO's `docs/nodes.md`), 192.0.2.17 to .20 — four of the same
  build, Ubuntu on the metal, an RTX 4070 with 12 GB, 62 GB of RAM, a C compiler and CUDA. `n6` is of
  the same build and is not a training machine: it serves the checkpoints (`docs/llm-server.md`), and
  a training run would take their card.
- **The venv stands on uv's own Python, never on the system's.** torch's native Triton kernels are
  compiled on the node at the first step against the interpreter's development headers, and uv's
  interpreter carries its own while the system's are installed on one node and missing on the next.
  A venv found standing on the system Python is reported as not ready and is made again.
- All four are jake nodes, so each is reached through its hub rather than by SSH. The console is
  the owner's jake checkout, run as `bun ~/repos/ahas/jake/src/console/main.ts`: its `exec -a <node>
  '<command>'` runs a command and `upload` / `download` carry a file across.
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
  `compare.py`, the resume bookkeeping they share and `pyproject.toml`, a uv venv built from it with
  `laya` pinned, and the dataset folders under `data/`. No server, no unit and no token: a node
  trains, and the deciding stays on n6. `uv pip install -r pyproject.toml --extra savings` adds
  bitsandbytes, which only the 8-bit optimizer run needs.
- **A run is detached with `setsid`.** The hub stops a command it is streaming after five minutes, and
  the stop reaches the whole process group, so a run started with `nohup` alone dies with it. What
  survives is `setsid nohup … &` with its output redirected to a log the next `jake exec` reads.
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
seeds each, and calibrates and measures every one the same way. The figures below are the whole
archive's dataset — every gate, 1,303 training sequences, 1,847 test questions — as the balanced
agreement on the test split, seed by seed. **This is the side-by-side measurement a saving has to
pass, it is settled, and it is not run again per gate.**

| Run | Peak reserved | 4 epochs | Balanced, per seed | Plain agreement | ECE |
|---|---|---|---|---|---|
| Plain, micro-batch 8 | 6.83 GB | 106 s | 0.798 · 0.817 · 0.475 | 0.927 | 0.036 |
| Embeddings frozen | 4.44 GB | 100 s | 0.807 · 0.811 · 0.486 | 0.926 | 0.035 |
| AdamW 8-bit | 4.91 GB | 102 s | 0.473 · 0.811 · 0.487 | 0.927 | 0.033 |
| Both | 3.73 GB | 98 s | 0.805 · 0.824 · 0.489 | 0.926 | 0.035 |
| Micro-batch 4 | 6.82 GB | 148 s | 0.828 · 0.840 · 0.812 | 0.926 | 0.047 |

- **No saving is used and none is to be turned on.** 하스's word on it is 「그냥 품질저하되는 옵션은
  건들지마」: a setting whose figures fall is not weighed against the memory it would save. The card
  has 5 GB to spare at the fixed settings, so there is nothing to buy with one.
- **What the table settles is the run configuration:** micro-batch 4, an effective batch of 64, bf16
  and gradient checkpointing, the same for every gate and every node.
- **The one thing left for a card that runs short is offload** — DeepSpeed ZeRO-2 optimizer offload,
  and nothing before it: not the two savings, and not a smaller batch either, since the settings are
  fixed and 하스's word on that is 「그냥 모자라면 오프로드만」. It is not built and not installed,
  because the measured peak is 5 GB short of the card. A measured peak that comes near the 12 GB is
  what would call for it, and no run has produced one.
- **What the seeds say.** A seed in four collapses to the common answer of the biggest gate — a
  balanced figure near 0.48, which is what always answering the same thing scores — under the plain
  settings and under every saving alike. Micro-batch 4 was the one setting where no seed collapsed,
  and it is what `finetune.py` runs by default.
- **A checkpoint is never judged on one run.** Three seeds, and the balanced figure rather than the
  plain agreement, is what says whether a training worked.

## One gate to a node

- **Each gate is its own training run**, and a run takes a card to itself. All four nodes stand as
  jake nodes, so one gate goes to one node and four run at once, and each node takes the next gate
  of `docs/laya-gates.md` as its own finishes.
- **The run across the four has a document of its own** — `docs/training.md`: what a checkpoint
  carries and how a killed run is resumed from it, how the gates are assigned and what the run ledger
  records, where the checkpoints are collected, and the two tables the run is judged on.
