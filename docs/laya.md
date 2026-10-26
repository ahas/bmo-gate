# Laya decision filter

Laya is a small open decision model (`laya-multilingual`, 322M, Apache 2.0) that answers a
yes/no or multiple-choice question about a piece of text with calibrated probabilities. The gate asks it
on the house's own card, in two ways. Beside most of its probed gates the LLM gate stays, and
Laya either records beside it or answers for it only when it is sure enough and the gate allows it.
A gate whose provider is Laya has no LLM at all: Laya's answer is its verdict.

## The server it asks

Laya's server, its installation on its nodes, what it was measured at, the distilled data the ten split
gates are trained on and the training run that makes the checkpoints stand in this repository beside the
gates' own code, each in a folder of its own (`docs/layout.md`). What this document states is the contract
the gates' client is written against.

- **Where it runs:** on the registered nodes (the node unit's `docs/nodes.md`) the service's placement names,
  in the order they are asked, each as that service's engine there, behind the service's own MCP and
  OpenAI-compatible front and the tunnel that brings it to the operations machine (`docs/llm-server.md`).
- **Where the gate reaches it:** the service's relay, at the address the gate's `[laya]` setting names,
  which hands each call to the first of those nodes that can take it — a node that is off, loading or whose
  card someone else holds is passed by — so the gate asks one address whichever node answers. The front
  passes the two calls below through to the engine; its MCP tools and its OpenAI-compatible call are for
  other callers, and the gate asks none of them.
- **Its two calls:**
  - `GET /health` — for each gate it serves, the checkpoint and whether it is on the card now; beside
    those the device, the VRAM the process holds, how long the loads took and the Laya and torch
    versions. Its model line names every gate with its checkpoint.
  - `POST /decide` — the gate asking, a state and a set of named questions in, Laya's answer for each
    question out, as that gate's own checkpoint gives it: the probabilities, the chosen option and the
    confidence.
- **One call carries at most 128 questions**; more is refused as a request it cannot read. The server
  answers one call at a time and holds the rest in line, so calls sent together never share the
  card.
- **One call is laid out on the card all at once**, every question beside its own copy of the state,
  and the card also holds every gate's checkpoint. A call that needs more working memory than the
  card has left makes room by taking other checkpoints off the card and is decided there; it is never
  decided on the processor. One that does not fit even with its own checkpoint alone on the card is
  answered 503. At a full state a question costs the card about 8 ms, so 32 of them about a quarter of
  a second.
- **A call the server holds past thirty seconds** without answering is answered 504 by the front, which
  hangs up on it; only a line stuck behind something wrong meets that bound, and it reads as
  `timeout`.
- **While it loads** — about fifteen seconds for each checkpoint it serves — or while it is stopped, the
  front answers every call with 503, which reads as `unreachable`, so a restart is a gap in which every
  gate with an LLM runs on its LLM alone and a gate whose provider is Laya takes its default.
- **Token:** every call carries the service's one bearer token, kept `0600` in the token file the gate's
  `[laya]` setting names under the data root's `env/`. The token never goes into a table, a log, an
  environment variable or the console.
- **What a call costs,** from the operations machine through the front and the tunnel: one question about 40 ms,
  fifty about 75 ms and 128 — the most one call carries — about 200 ms. Every checkpoint stays on the
  service's card, so no call pays for a move.
- **Which checkpoint answers which gate** is the service's own setting on its node, one checkpoint per gate
  and none shared, and naming one there is the owner's as τ is. `/health` names each gate's checkpoint in
  its model line, and the gate reads it from the last health check (「The health watcher」); nothing here
  chooses a checkpoint. A gate the server holds no checkpoint for is turned away, and its pair is recorded as
  `refused`.
## The client

- **One module of the gate** asks the server; nothing else speaks to it.
- **Every call names the gate asking,** by the gate's own key, which is how the server picks that
  gate's checkpoint. The common path names it; a probe never does, and the name is not part of the
  input the pair records.
- **Where it points:** the address of the gate's `[laya]` setting. The gate's options offer Laya to a gate
  only where one is set. With no address set, Laya is never asked: every gate with an LLM runs on it alone,
  and a gate whose
  provider is Laya takes its default and records the failure as `unreachable`.
- **The token** is read from its file at each call, never kept.
- **Patience:** the asking gate's own time limit, read from its row of the gate options
  (the agency's `docs/own-llm.md`, 「Per-gate time limit」), which is the only place it is set; the client carries no
  wait of its own. It is counted from when the gate asks and covers the whole request: its wait in the
  line and every part of it. A gate with an LLM is given it for Laya apart from the LLM's own, so a
  slow Laya never costs such a gate its verdict.
- **A turn at the card is the engine's to wait for, not the client's.** The engine waits for its turn at the
  card inside the call, standing in the node's queue by the call's arrival, for as long as the call is
  held open (`docs/laya-server.md`, 「Sharing the card」), and decides the moment its turn comes. The
  client sends a call once and waits for its answer: it is never told to come back, and never asks again.
  What bounds the wait is the gate's patience, and on the way the front's thirty seconds; past either, the
  call is a `timeout` and the gate goes its own way.
- **The client keeps its own line.** A process sends one call at a time and the next only once the one
  before it has been answered or has failed, so calls sent together never share the card. Every call
  in the line waits on its own gate's patience alone: one whose patience runs out while it waits
  leaves the line as `timeout`, and a call ahead of it running out of patience ends nothing but that
  call.
- **A call that waited behind an `unreachable` or a `busy` one is not sent.** It leaves the line with that
  call's failure, a `busy` one with its reason, the moment its turn comes, since the door that turned the call
  ahead of it away, or the card that was taken, turned it away while it waited; so the gates of one turn wait
  for one failed call while the server is out of reach or its card taken, not for one each, and each goes its
  own way at once. A call that joins the line after that failure is sent as any call is.
- **A request is asked in parts.** The client cuts its questions, in their order, into parts that each
  hold at most 128 questions and at most 32,768 tokens of input — every question counted with the
  state beside it, as the card lays it out — each part carrying the same state. At a full state that is
  about 32 questions a part; at a short one it is 128. The parts go into the line in order, and the
  reply is every part's answers together, its time the whole wait. Any part failing fails the whole
  request with that part's failure kind, and the parts after it are not sent, so a gate never reads
  an answer to some of its questions only. No gate cuts its own questions to fit a call.
- **Input budget:** Laya reads at most 1,024 tokens per question, 256 of them kept for the question
  and its options. The client counts generously — a character outside ASCII as one token, about three
  ASCII characters to a token — and sends nothing whose state runs past 768 or whose question runs
  past 256; that counts as `too-large`. Laya itself would cut a long state without saying so. Every
  probe fits its own input inside that budget (「Fitting an input」), so a turn is never `too-large`
  for being long; the check stands for a probe that failed to.
- **Failure kinds**, each without any request or answer body in it:
  - `unreachable` — no connection (the tunnel or its door on the operations machine down, or no address set), or a
    503 that is not a busy card: the service there but unable to take the call, its engine stopped or loading,
    or no node behind the relay taking it
  - `busy` — a 503 the engine gave for its card, read from the reason it words it with
    (`docs/laya-server.md`, 「The server」): the card taken outright by a claim, no place for the engine among
    the node's occupants, or no room on the card for the call. The reason goes with the failure: the
    judgement line names it as `busy: <reason>`, and the health row reads `busy` (「The health watcher」)
  - `timeout` — no answer within the gate's patience, its wait in the line included, or a 504: the
    front giving up on a call the server held past thirty seconds
  - `refused` — the server said no (a wrong token, a request it could not read, or a gate it holds no
    checkpoint for), or the token file here is missing, empty or not `0600`
  - `bad-answer` — an answer that is not the shape asked for, or any other server error
  - `too-large` — refused before sending, over the input budget
- **A failure never reaches the gate as an error.** It is recorded, and a gate with an LLM goes on as
  if Laya did not exist, while a gate whose provider is Laya takes its default (「When the service is
  out of reach」).

## Modes

Each gate has one Laya mode. What it does to that gate's verdict:

- **`off`** — the gate runs its LLM alone, exactly as it would without Laya. Nothing is recorded.
- **`shadow`** — the LLM decides, and its verdict is what the gate uses, unchanged. Laya is
  asked the same question at the same time; the gate never waits for it, so the gate is not a moment
  slower. Once both have settled, the pair is recorded, a Laya failure included.
- **`filter`** — Laya is asked first. If its confidence is at or above the gate's τ, its verdict is the
  gate's and the LLM is not asked. Otherwise, and on any Laya failure, the LLM decides as usual. A gate
  whose probe settles one question at a time is compared with τ question by question instead
  (「A gate settled one question at a time」).
- **`asymmetric`** — like `filter`, but Laya may only settle the gate's safe verdict. Any other Laya
  verdict, however confident, goes to the LLM. Settled one question at a time, a question stands only
  where what Laya said of it alone is the safe verdict. This is for gates where a wrong "safe" costs little and a
  wrong "unsafe" would change what people see or let harm through.
- **A stop is not a failure.** When somebody stops a gate's run, the stop goes on to the caller in every
  mode, and nothing is recorded as Laya's answer (the agency's `docs/agent-control.md`, 「Stopping」).
- **The common module knows no gate by name.** It supplies the client, the modes, the τ comparison, the
  record and the fallback; every gate brings its own probe.
- **The modes are for a gate with an LLM.** A gate whose provider is Laya has no LLM to set Laya
  beside, so its mode and τ are not read (「A gate whose provider is Laya」).

## A gate settled one question at a time

A probe whose questions are each a verdict of their own — one yes/no per candidate, where the gate's
verdict is the set of candidates answered yes — may declare that Laya settles it one question at a
time. No gate of the order does: the output gate's probe asks one question (「Each gate's probe」).

- **What it declares:** how its input narrows to some of its questions — the same turn with only those
  candidates — and how a verdict made of two parts is joined, the part Laya settled first. Its gate
  profile says the same, which is what the agreement is counted by (「Agreement」).
- **In `filter` and `asymmetric`:** Laya is asked about every question, in as many calls as that
  takes. Each question is then read on its own — its label and its confidence — and compared with τ
  on its own, the mode's rule applied to it as to a whole verdict.
  - **Every question stands** — Laya's verdict is the gate's and the LLM is not asked.
  - **None stands**, and on any Laya failure — the LLM decides the whole input, as in a gate settled
    whole.
  - **Some stand** — Laya's verdict on those questions is kept, the LLM is asked about the input
    narrowed to the rest and nothing else, and the gate's verdict is the two joined. Where the LLM
    gives no verdict, the gate has none: a part of it is not a verdict, and the gate's own fallback
    for an LLM that gave none runs as it would.
- **What is recorded:** one row for each part the turn was decided in. A turn Laya settled whole, or
  one it settled none of, is one row as in any gate. A turn it settled in part is two rows: one for
  the questions it settled — their state and questions as the input, Laya's answers and verdict on
  them, used `laya`, no LLM verdict — and one for the rest — their state and questions, Laya's
  answers and verdict on them, the LLM's verdict on them and what it says each should have been, used
  `llm`. So every row compares the two sides over the same questions.
- **`shadow` and `off` are unchanged:** a shadow pair is the whole turn in one row.

## Fitting an input

A probe hands Laya an input inside its budget whatever the turn's size, cut the way the training tooling
cuts the rows the checkpoints were trained on, so what a gate asks at a turn and what its checkpoint
learned from are the same shape.

- **A transcript is its newest whole messages that fit** beside the questions, the oldest the first
  to stay out. The training tooling builds every row of a gate that reads a room's messages this way — the
  window of the room-shape gates and the reference rows' 「newest lines that fit」 — so the cut needs
  no retraining.
- **A newest message that does not fit on its own** is kept by its opening, cut to what fits, rather
  than leaving the state empty. The training tooling makes no row of such a turn, so this one state is outside
  what the checkpoints saw; its prefix, its sender and the start of its text still stand in the shape
  they were trained on.
- **A question past its 256 tokens** keeps its opening, cut to what fits. The question's fixed wording
  stands first and a candidate's own words after it, so only the tail of an overlong index line or
  rule is lost.
- **What is recorded is what was sent:** the pair's input is the fitted state and questions.
- **An answer being judged** keeps its opening, cut to what fits, where it does not fit on its own,
  and then has no room for messages beside it. Only its tail is lost to the judgement.
- **The formatting gate** fits its markdown by its own reduction (「Each gate's probe」).

## A gate whose provider is Laya

- **Laya is a provider a gate may be put on,** chosen in the gate's provider cell like any other, and
  offered only to a gate whose profile declares that Laya can give its whole verdict: its probe reads
  every verdict the gate can give, and the gate names the verdict it takes when neither Laya nor its
  fallback LLM gives one.
  - **The formatting gate** (`output-format`), whose initial provider is Laya
    (`docs/output-gate.md`), is the one gate that does. Where neither gives one, the gate's default fold
    stands.
- **One call is the verdict.** The gate asks Laya once, and Laya's label stands whatever its
  confidence. No τ is compared and no LLM is asked beside it.
- **Its model is its checkpoint.** A gate on Laya is answered by the checkpoint the service names for
  that gate's key, so no tier is read for it and no tier mapping holds a Laya model
  (the agency's `docs/model-tiers.md`). The agent management screen shows the checkpoint's name from the health
  row in the gate's tier cell, and the cell cannot be pressed while the gate is on Laya.
- **When Laya gives no verdict** — any failure kind, `too-large` included — the gate asks its
  fallback LLM once: its own setting in its gate options row (the agency's `docs/own-llm.md`, 「A gate runs on
  its one provider」), unset for the provider its road would begin on, `none` for no LLM. The LLM is
  run exactly as the gate runs it off Laya, on the gate's own time limit given anew, and its verdict
  is the gate's. Where the setting is `none`, or the LLM gives no verdict either, the gate takes the
  verdict it names for that. Either way it logs Laya's failure as its error, writes its judgement
  line as who decided — the LLM and its model, or the default — and why, a busy card with the engine's
  reason, and records the pair with the failure's kind.
- **The fallback LLM is the gate's, chosen in its row:** the agent management screen shows it as a
  choice cell beside the gate on Laya — automatic, none, or a provider by name.
- **What is recorded:** one pair per call in the verdict record, its mode `road`: used `laya` with no
  LLM verdict beside it where Laya decided, used `llm` with Laya's failure and the LLM's verdict
  beside it where the fallback LLM did. Agreement is counted over pairs with both verdicts, so a gate on Laya adds
  none; its figures are the checkpoint's own tables (`docs/training.md`, 「The tables」) and a comparison
  made over the real messages.
- **The route stays one row.** The gate's route row holds `laya` where a provider's name would stand;
  moving the gate back to an LLM is choosing that provider in the same cell.

## Each gate's probe

A probe is the part of a gate that speaks Laya. The gate declares it itself: how its input becomes a
Laya state and questions; what Laya's answers come to, as a label and a confidence; which gate verdict
a label stands for, where Laya may settle it at all; how the LLM's verdict becomes a comparable label;
what a label says each question should have been answered, which is what a verdict teaches Laya;
optionally, how a run the agent log kept is read back into its input and its verdict; and, for a gate
that may be filtered asymmetrically, which verdict is the safe one. Comparing the
confidence with τ is the common module's, never the probe's. A gate with no probe cannot be given a
mode other than `off`.

- **A probe that cannot ask** — an input past Laya's reach — says so, and the pair is recorded as
  `too-large` with no input. A probe that breaks counts as Laya giving a `bad-answer`; the gate runs on.
- **Where the pairs are written** is the gate's own database, by whichever route the gate runs for.
- **Tests never reach the server:** every test run starts with the address empty, and a test of Laya
  passes its own.
- **A gate asks its checkpoint the wording that checkpoint was trained on.** A gate's own wording is English:
  each question's fixed wording and the word a candidate is named by stand in the gate's Laya question data,
  the same words the distilled data carries (`docs/laya-gates.md`); only the state is the room's words, as
  written.
  - **A checkpoint that learnt an earlier wording is asked that wording,** word for word. Which ones did is
    a table beside the earlier wordings, the `learnt` table of `prompts/tooling/laya-wordings.toml`: a
    checkpoint's run — the folder `/health` names for the gate, without its step — and the wording each of
    its questions learnt.
  - **The checkpoint is the one the last health check names for the gate.** A gate whose checkpoint the
    table does not list, or for which no check has named one yet, asks its own wording.
  - **The formatting gate's probe is the one that reads the table,** the one gate here Laya serves
    (`docs/laya-gates.md`, 「Which gates Laya serves」). Its checkpoint
    in service (`real-2-fold`) learnt the Korean wording of the fold question and is asked it. A checkpoint
    retrained on the English question is asked the English one once it serves, and moving a gate's mode
    meanwhile is the owner's (「Who decides」).

- **Formatting gate (`output-format`)** — one yes/no question: should this message be folded. Laya's
  yes is FOLD and its no is OPEN. The state is the markdown as written, reduced to its opening, its
  closing and its counts so a message of any length fits one call — never `too-large` — built to the
  character as `docs/laya-gates.md` (「The output format」) specifies, since the checkpoint was
  trained on exactly that reduction. The probe belongs to the dialect that declares the fold
  decision, as the gate's name, model and instructions do (`docs/output-gate.md`); a dialect that does
  not fold has no gate and so no probe.
- **How confidence is read:** for a choice question, Laya's own confidence; for a yes/no question, the
  larger of the two probabilities; for a probe asking several questions, the lowest of its questions'
  confidences. A probe settled one question at a time has each question's own confidence compared
  with τ, and a row it records carries the lowest of that row's questions.

## Mode and τ per gate

- **Where they live:** the gate's row of the gate options table (`gate_options`), in the columns
  `layaMode` and `layaTau`, beside its time limit (the agency's `docs/own-llm.md`, 「Per-gate time limit」). An empty
  mode means the gate's profile default.
- **The profile defaults:** `shadow` for the formatting gate on an LLM road; `off` for every other gate. A gate's
  profile names a default mode only when the gate declares a probe, so a profile with none is a gate
  with no probe.
- **τ** is a number from 0 to 1, empty until chosen. `filter` and `asymmetric` are refused for a gate
  without one, and so is taking τ away from a gate in either; `shadow` and `off` do not read it. A row
  that says either with no τ runs as `shadow`, and a gate without a probe runs as `off` whatever its row
  says.
- **A mode is taken only where it can run.** Choosing a mode is refused, with the reason said, where
  the gate could not run in it:
  - `asymmetric` for a gate whose probe names no safe verdict, which no gate of the order names. A profile that
    names one says so beside its default mode, and a row that says `asymmetric` for any other gate runs as
    `shadow`.
  - `filter` and `asymmetric` for a gate the server holds no checkpoint for, by the last health check's
    model line — or where no check has yet named one. Laya would turn every call of such a gate away.
    A checkpoint gone after the mode was chosen is not undone here: every call is then recorded as
    `refused` and the LLM decides, as on any failure.
- **The console reads the same refusals:** the gate's view carries which modes the gate would refuse
  it and why, and its mode cell offers those greyed with the reason beside them.
- **Each field is written on its own:** a change of the time limit, the mode or τ leaves the other two
  as the row had them.
- **Where they are chosen:** the gate's row in the gates tab of the agent management screen
  (the web unit's `docs/web.md`), through `POST /options/{gateName}`; the gate writes the row, the console never
  does.
- **Who decides:** choosing τ for a gate and moving it from `shadow` to `filter` or `asymmetric` is
  the owner's decision, made after they have seen that gate's agreement numbers. No job and no agent makes that
  move on its own.

## The verdict record

- **One row per question pair** — for a gate settled one question at a time, one per part of a turn
  (「A gate settled one question at a time」) — in the gate's `laya_verdicts` table: the gate; the room and the
  message, when the gate judges a message; the subject, when it judges something else, such as a note; a
  hash of the probe's input; the probe's input itself, as the state and questions sent; Laya's
  probabilities and confidence; Laya's verdict and the LLM's, as the probe's comparable labels; what
  the LLM's verdict says each question should have been answered; for a
  gate with a safe verdict, whether each of the two was it; the mode; whose verdict the gate used;
  Laya's time; the failure kind, if Laya had none; and when.
- **Why the input is kept here:** the agent log keeps a gate's input for a week at most, and fine-tuning
  data needs it for longer.
- **Its bound:** per gate, the newest 50,000 rows, none older than 365 days. The gate sweeps the table
  when it starts and again every 500 rows written.
- **A gate on `off` writes nothing here.** The gate's own judgement and road records are written as
  before, whatever the mode.

## The health watcher

- **The gate watches the Laya server.** It asks `GET /health` once a minute, and as it starts, reading
  the address and the token from its `[laya]` settings at each check.
- **What it keeps:** one row in the gate's `laya_health` table: the state — `up`, `busy`, the failure
  kind, or `off` where no address is set and nothing is asked; no row at all reads as not yet checked —
  the model, the device, the VRAM, the load time and versions, the address it asked, how long the check
  took, and when it was checked and when it last answered, in epoch milliseconds. A failed check keeps what
  the server last said about itself.
- **A busy card is the row's `busy`.** The server answers its health while its card is taken, so a check
  alone reads `up` while every call fails. A check the server answers while the last call to decide came
  back `busy`, and no call has been answered since, writes `busy` instead; the first call answered after
  it lets the next check write `up`. `GET /health` reads it as `busy`, never as `down`.
- **What the console reads** is that row and every gate's agreement, through `GET /laya`, with each probed
  gate's mode and τ read from its own row of the gate options; the node the address names is where the
  state leads (the web unit's `docs/web.md`).
- **When the state or the model moves**, the gate puts `laya.changed` into its event stream (`GET /events`), so an
  open screen reads the row again.
- **The node check is not involved.** A node's state says whether the machine is reached; Laya's state
  says whether this one service answers, and belongs to the module that uses it (the node unit's `docs/nodes.md`).

## When the service is out of reach

- **Every gate with an LLM runs as it does without Laya.** In `shadow`, the LLM's verdict was the gate's
  anyway; in `filter` and `asymmetric`, a failed Laya call hands the question to the LLM. No gate waits
  longer than its own time limit for Laya, and in `shadow` it does not wait at all.
- **A gate whose provider is Laya asks its fallback LLM** (「A gate whose provider is Laya」), and
  takes its default only where that is `none` or gives no verdict either, said as its error and in its
  judgement line.
- **The failure is recorded** with the gate's pair, and the health row shows it, so the console tells a
  cold service from a Laya that disagrees.

## Agreement

- **Per gate**, over its recorded pairs where both Laya and the LLM gave a verdict:
  - the number of pairs, and the number of Laya failures beside them
  - **agreement** — the share of pairs where Laya's verdict equals the LLM's
  - for each τ of 0.5, 0.6, 0.7, 0.8, 0.9, 0.95 and 0.99: the **coverage** (the share of pairs with
    confidence at or above τ, which is the share Laya would settle) and the agreement within that share
- **For a gate settled one question at a time** the same figures are counted over questions rather
  than pairs, since a question is what its τ settles: each question of a row where Laya answered and
  the LLM's verdict says what it should have been, Laya's answer to it against that, at the
  question's own confidence. Beside them stands the share of the questions Laya answered that it
  settled for the gate — those of its rows used `laya` — which is what its `filter` mode buys.
- **For a gate with a safe verdict**, the number that matters is the agreement among the pairs where
  Laya said safe at or above τ: how often the LLM said safe too.
- **Where it is read:** `bmo gate laya-agreement` prints the table — a block per gate, a line per
  τ — from the gate's database, which it only reads, or the one `--db` names (`--stage` for one gate, `--json`
  for the numbers as they stand), and the agent management screen shows each gate's agreement and pair count — its question count, for
  a gate settled one question at a time.
- **The bar the research proposed** is 98% agreement above τ before a gate moves off `shadow`; the choice
  is still the owner's.

## What stands here and what does not

Laya is a provider that stands on its own beside the gates, so the line inside this repository is drawn at
the call: the gates' code asks, and everything behind the answer stands in the Laya folders.

- **The gates' code:** the client, each gate's probe, the mode and τ a gate runs on, the gates whose
  provider is Laya, the verdict record, the health watch, what a gate does when the service is out of
  reach, and the agreement read off the record.
- **The Laya folders:** the server's code and its installation (`runtime/`), the specification of the ten
  split gates, the distilled data they are trained on and the training run across the training nodes
  (`training/`), and the declarations of the checkpoints (`weights/`); the checkpoints themselves are
  runtime data.
- **The verdict record and the health row are the gate's tables.** Both are written by the gates as they
  run and read by the console through the gate's routes. The training tooling reads them read-only, and
  never writes them.

