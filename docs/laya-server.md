# The Laya server and the training behind it

Laya is a small open decision model (`laya-multilingual`, 322M, Apache 2.0) that answers a yes/no or
multiple-choice question about a piece of text with calibrated probabilities. It stands on its own as
an installed provider: this repository holds the server, the data the checkpoints are trained on and
the training itself, and BMO holds only the client that asks it and the configuration of which gate
asks (BMO's `docs/laya.md`).

## The server on home-pc

- **Where it runs:** node `home-pc` (BMO's `docs/nodes.md`), in its WSL Ubuntu, as a systemd user unit
  `bmo-laya.service`. Linger is on for the account, so the unit starts when WSL starts, with nobody
  logged in.
- **What it is:** the small HTTP server kept in this repository under `laya-server/`, installed into
  its own Python 3.12 virtual environment by `uv` in user space. The install script in that folder,
  run from main-host over the node's SSH, is the one way it is put there or updated, and it installs
  no system package and asks for no sudo.
- **What the machine carries underneath it:** a C toolchain and the Python headers —
  `build-essential` and `python3-dev` in the WSL Ubuntu. torch's native Triton kernels are built
  against the venv's Python the first time a decision meets an input shape, and without them every
  decision ends in `Failed to find C compiler`. A kernel is built once for each of the few shapes the
  input padding leaves, costs 40 to 120 milliseconds the once, and is kept in the account's triton
  cache on disk, so it survives a restart and the shapes a gate asks are warm within a handful of
  calls; a decision on a warm shape is not a millisecond slower than one with the kernels off. These
  are system packages and the install script is not what puts them there: the account's sudo asks for
  a password, and root on that machine is reached through WSL's own interop, `wsl.exe -u root`.
- **What it holds:** on start it loads `laya-multilingual` from `convaiinnovations/laya` onto CUDA and
  keeps it there, so no request ever waits for a load. It then makes one decision of its own before it
  opens the port, so a server that answers `/health` can also decide, and one that cannot decide stops
  and is restarted by the unit.
- **Its environment:**
  - `USE_TF=0`, which the model card names as the cure for a load that hangs.
  - torch comes as PyPI's default build (CUDA 13), which the 3080's Windows driver runs.
- **While it loads** (about 20 seconds from the local model cache), the port does not answer at all:
  a call then ends by timing out rather than being turned away.
- **A fine-tuned checkpoint** is used in place of the hub model only when the unit's environment file
  names a checkpoint directory (「The training loop and calibration」). Nothing switches it on its own.
- **Port:** `7431` on all of home-pc's addresses, which mirrored networking puts on `192.0.2.8x`.
  Every other service on home-pc keeps off this port.
- **One call carries at most 128 questions**; more is refused as a request it cannot read.
- **Its two calls:**
  - `GET /health` — the model and where it came from, the device, the VRAM the process holds, how long
    the load took, the Laya and torch versions, and the calibration temperatures in use, if any.
  - `POST /decide` — a state and a set of named questions in, Laya's answer for each question out, as
    Laya gives it: the probabilities, the chosen option and the confidence.
- **Token:** every call carries a bearer token. The same token is kept in two files, each `0600`:
  `$BMO_DATA_DIR/env/laya.token` on main-host (without `BMO_DATA_DIR`,
  `~/.local/share/bmo/data/env/laya.token`), and `~/.config/bmo-laya/token` on home-pc. The token never
  goes into the archive, a log, an environment variable or the console.
- **Installing and updating:** `bash laya-server/install.sh` from this checkout on main-host. It makes
  the token once if there is none, copies the server and the unit across, builds or updates the venv,
  enables and restarts the unit, and waits until `/health` answers. The unit's own settings file,
  `~/.config/bmo-laya/env`, is made empty once and never overwritten.
- **Restarting it:** over the node's SSH, `systemctl --user restart bmo-laya`; `journalctl --user -u
  bmo-laya` holds its log, one line per call and no request body.
- **Timing a call:** `laya-server/bench.py` asks the server with 1, 10 and 50 questions on a Korean
  state, from home-pc or from main-host.

## Measured on the 3080

- **VRAM:** the card holds about 1.7 GiB with the server stopped (the Windows desktop). Loading the
  model adds about 1.5 GiB, and a 50-question call raises that to about 2.0 GiB, which the process then
  keeps. torch reports 1.3 to 1.6 GB of its own reserve inside that.
- **Time per call**, 50 calls each, p50 / p95 in milliseconds:

  | Questions | Inside the server | From home-pc | From main-host |
  |---|---|---|---|
  | 1 | 18.9 / 22.6 | 20.4 / 24.1 | 21.3 / 22.7 |
  | 10 | 23.5 / 35.4 | 25.0 / 36.9 | 25.4 / 25.9 |
  | 50 | 69.6 / 72.7 | 71.4 / 74.5 | 74.0 / 74.7 |
  | 100 | 120.7 / 125.8 | — | 123.2 / 129.3 |
  | 128 | 150.3 / 159.8 | — | 158.5 / 168.0 |

  The 100 and 128 rows are 30 calls each; after a 128-question call the card holds about 4.3 GiB in
  all.

- **The network** adds about 3 to 5 milliseconds between main-host and home-pc.
- **What it means for the gates:** one question is about 20 ms, fifty are about 75 ms and 128 — the
  most one call carries — about 160 ms, all of it far under the client's two seconds.

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
2. **Carry it to a node** with `jake upload`, or to home-pc with `scp` — into `~/bmo-laya/data/<name>/`.
   On home-pc the install script puts the training scripts beside the server; on a training node they
   are uploaded with the data by the setup verb.
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
   - **Balance:** within each gate, no answer is kept more than three times as often as the gate's
     rarest (`--balance-ratio`). A reference gate answers no to almost every candidate, and
     unbalanced data teaches Laya to answer no always, which agrees with it as often as a real
     judgement and decides nothing. `--per-gate` also caps how many sequences one gate gives.
   - It writes a new directory, a rolling checkpoint the run can be resumed from, and
     `train_meta.json` with the sequences per gate, each epoch's time and loss, and the peak memory.
     It never writes over a directory that exists, and `--resume` is how a killed run carries on from
     what it saved rather than starting again (`docs/laya-train-run.md`, 「The resume contract」).
   - **Memory:** training alone reserves about 6.8 GB. With the server loaded beside it the 3080 peaked
     at 9.6 of its 10 GB, so stop `bmo-laya` for a long run; the gates meanwhile run on their LLMs.
     A training node's 4070 has the card to itself and never comes near its 12 GB.
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
   process of its own (`LAYA_CHECKPOINT=<dir>` with `server.load_decider()`), which loads it and makes
   one decision while the unit goes on serving the hub model.
7. **Put it in service** by naming the checkpoint directory as `LAYA_CHECKPOINT` in
   `~/.config/bmo-laya/env` and restarting the unit. That step, like τ, waits for 하스, and `/health`
   then names the checkpoint.

- **Any Linux host with a CUDA GPU and Python 3.10 or later** runs the same scripts in the same venv.
  home-pc's 3080 has the server beside it and holds a run at micro-batch 4 with the unit stopped; the
  training machines are n2 to n5.

## Training on the nodes

- **The machines:** nodes `n2` to `n5` (BMO's `docs/nodes.md`), 192.0.2.17 to .20 — four of the same
  build, Ubuntu on the metal, an RTX 4070 with 12 GB, 62 GB of RAM, a C compiler and CUDA. `n6` is of
  the same build and is not a training machine: it carries the house LLM service
  (`docs/llm-server.md`), and a training run would take its card.
- **The venv stands on uv's own Python, never on the system's.** torch's native Triton kernels are
  compiled on the node at the first step against the interpreter's development headers, and uv's
  interpreter carries its own while the system's are installed on one node and missing on the next.
  A venv found standing on the system Python is reported as not ready and is made again.
- All four are jake nodes, so each is reached through its hub rather than by SSH. The console is
  the owner's jake checkout, run as `bun ~/repos/ahas/jake/src/console/main.ts`: its `exec -a <node>
  '<command>'` runs a command and `upload` / `download` carry a file across.
- **What a node carries is read off the node, not from here.** The GPU, the free VRAM, the CUDA and
  python versions and the installed package versions move with the machine, so the setup verb reports
  the nodes side by side rather than this document stating them (`docs/laya-train-run.md`).
- **What is put there:** `~/bmo-laya` in the node's own account — `finetune.py`, `calibrate.py`,
  `compare.py`, the resume bookkeeping they share and `pyproject.toml`, a uv venv built from it with
  `laya` pinned, and the dataset folders under `data/`. No server, no unit and no token: a node
  trains, and the deciding stays on home-pc. `uv pip install -r pyproject.toml --extra savings` adds
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
- **The run across the four has a document of its own** — `docs/laya-train-run.md`: what a checkpoint
  carries and how a killed run is resumed from it, how the gates are assigned and what the run ledger
  records, where the checkpoints are collected, and the two tables the run is judged on.
