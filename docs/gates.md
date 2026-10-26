# Gates

## What a gate is

- A gate is a model-only run of the gate's: one prompt in, one text out, no shell, no tool and no session of
  its own. Which work keys are gates is declared once, in the gate order of the gate's own policy
  (`docs/layout.md`), and every list of gates — the console's tables, the route views, the Laya views — is
  read from it through `GET /gates` (`docs/boundary-api.md`).
- A gate runs on its one road (the agency's `docs/own-llm.md`, 「A gate has one road」), and what reaches a
  model on each road is `docs/boundary-api.md`, 「How a gate run reaches a model」.
- One gate's runs take turns: the next run of a gate waits until its previous one has returned, so two runs
  of the same gate never stand at the road together while different gates do. A gate whose road is a
  provider's program takes as many runs at once as its pool's bound (「How many runs stand at once」 below). A
  caller that bounds how many of its own requests are out at once marks each request to stand beside the
  gate's other runs instead, and the bound is then the caller's alone — the translator's: a document's
  translation keeps three parts out at a time (the web unit's `docs/documents-viewer.md`), and the translations
  route keeps no more parts out than the translator's pool bound across every call standing (`docs/api.md`,
  「Translations」).
- A gate whose caller has a way of its own without it declares so in its profile, and only such a gate may
  be switched off for the whole deployment: its switch is its row of the gate options table (the agency's
  `docs/own-llm.md`, 「Per-gate time limit」), and a gate switched off is never asked. Apart from that, each
  agent answering in a room has a switch of its own for every gate its turns pass (「Each agent's own
  gates」 below).
- A gate's options are kept for each designated agent: a row of the gate options table per gate and agent,
  read for the agent whose turn the gate runs in. A companion's rows are copied from the chat agent's when
  it stands (`POST /options/copied`, the agency's `docs/agent-ownership.md`).
  - The turn's agent travels with the work: a companion's turn asks its reference selection as that
    agent's turn, and every gate asked from inside reads that agent's row. A gate asked outside any agent's
    turn reads the chat agent's.
- **No gate writes what is known about a person.** What the brain knows of a person is its facts, one row
  each, written by the agent that read them through the brain's write judgement, which weighs a candidate
  against the live rows most like it before anything is written (the brain's `docs/design.md`, 「Writing」).
  A gate has no tool to look those rows up and no way to apply a judgement on them, so writing a fact is
  never a gate's run. A person's standing sheet is the brain's own rendering of those facts (the brain's
  `docs/design.md`, 「A person is a subject」), which the reference reads as it stands
  (`docs/reference-selection.md`, 「What attaches without a gate」), so no gate summarises one either.
- The session summariser stands at the place the gate order gives it and is called like a gate, but it is a
  recollector, not a gate. No unit asks it: the agency keeps no session summary (its `docs/sessions.md`), so
  it runs under the evaluation set alone (`docs/boundary-api.md`, 「Contract gaps」).
- What each gate runs on is its route, kept with every other work key's by the agency (the agency's
  `docs/own-llm.md`, 「A gate has one road」). What each one is asked is in its own document: the output gate
  in `docs/output-gate.md`, the reference gates in `docs/reference-selection.md`.

## A gate on a provider's program

- **Each judgement on Claude Code, Codex or OpenRouter is one thrown-away agency session:** started apart on
  the provider and the model the gate's tier maps to there, sent one turn with the gate's instructions as its
  whole system prompt, a fresh session, no tool, no MCP server and thinking off where the request asks (the
  agency's `docs/launch-lines.md`, 「Gate runs」). The gate knows no pane, no program and no backend, and a gate
  run keeps no session from one judgement to the next.
- **A login that fails** is the agency's login walk's failure, and the next login the gate's key is offered
  takes the judgement.
- **A judgement on a registered model** is one request through the agency's model gateway, answered room as the
  gate's tier names it, never less than the gate's own floor (`docs/boundary-api.md`, 「How a gate run reaches a
  model」).

### How many runs stand at once

- **A gate stands no more runs at once than its pool's bound:** the default in the gate's `gate-pool`
  policy, three, or the bound the gate's own profile names. The translator names four, the most parts the
  translations route has out at once.
- **No run free:** while every place of a full pool is taken, the judgement waits for one to come free until
  the gate's own wait (its gate options row) runs out. The gate then has no answer, its road records
  `timeout`, and its caller's own way without it stands (the agency's `docs/own-llm.md`, 「A gate that did
  not answer is a gate with no answer」).
- **The wait bounds the judgement too.** What is left of the gate's wait once its run has started bounds the
  turn. A turn past it is stopped, and the gate has no answer; where nothing is left, the judgement is not
  sent.

### What a judgement records

- The same as on every road: a line on the service's log as the run starts and as it ends, naming the gate, the
  road and how it ended, never the material it was asked about; and the road's row with how long the judgement
  took from the call to its answer and the tokens the road reported. What the run spent is the agency's
  `usage-spent`.

## The gate order

- **The gate order** is where each gate stands against a chat turn. It is declared once, beside the list of
  gates, and the list of gates is derived from it, so a gate cannot exist without a place.
- The gate order has four parts:
  - **the pre-gate** — the gates that run before the chat agent writes its reply;
  - **the post-gate** — the gates that run after the reply is written, before it reaches the room;
  - **off-turn** — the gates that run outside any chat turn;
  - **shelved** — the gates no turn and no caller asks.
- A part is a list of steps in the order a turn passes them. A step holds one gate, or several gates the turn
  starts together and waits on together. The shelved part is a list of gates, each marked where it is one of
  the reference pickers.
- A step may carry a condition: it runs only in the turns the condition names.
- A gate that runs in both the pre-gate and the post-gate part stands in each, at the step where it does that
  part's work. A gate never stands twice within one part, and an off-turn or a shelved gate stands in no other
  part.
- The gate order is checked against the turn by tests that drive a turn and record the order the gates are
  called in, so a turn that moves a gate fails its tests until the gate order moves with it.

### The pre-gate

1. `session-summary` — only when the turn replaces the chat agent's session, and the summary of the session
   being let go is written before the new one is asked anything. It stands at the head of the turn, before
   every other gate.

A turn's reference is asked of no gate: `POST /reference/selected` carries what no gate picks, and the agent reads
the brain's index and its pieces itself (`docs/reference-selection.md`).

### The post-gate

1. `output-format` — only in a room whose dialect folds (bmo-chat's `docs/protocol.md`): it decides the fold
   for each part of the reply, one part after another. A room whose dialect does not fold sends the plain
   text and never reaches this step.

### Off-turn

- `translator` — translates a document the console's document viewer shows, what reaches a job worker into
  English, and what a worker writes onto an item into the owner's language (bmo-job's
  `docs/worker-language.md`). Its runs go out on the agency's work key `translate` wherever the agency serves
  that key, and on its own work key otherwise (「Where a gate's runs go out」).
- The output gate also runs on a message the chat agent sends to a room outside any turn. That does not give
  it a place in this part: it stands where it runs within a turn.

### Shelved

`system-documents`, `room-rules`, `library-knowledge`, `people-search`, `room-memories`, `situation-rules`,
`sanitizer`, `document-seek`, `voice-polish` and `voice-reading`.

- **A shelved gate is never asked,** in a turn or out of one. Its profile, its options and its judgement history
  stay readable (`GET /gates`, `GET /options/{gateName}`, `GET /judgements`), and `GET /gates` lists it under the
  part `shelved`.
- **What a route answers in its place:** `POST /stages/{gateName}/runs` answers null, as for a gate switched
  off; the sanitiser's routes answer the text as it came, unchanged; the knowledge routes answer no piece; and
  `POST /documents/sought` is 409 `shelved` (`docs/api.md`).
- **The evaluation and replay commands** still read a shelved picker's libraries and score it on a stored turn
  (`docs/gate-eval.md`); nothing they do reaches a turn.

### Where a gate's runs go out

- **A gate's runs go out under its own work key,** the gate's name, which the agency resolves to a provider, a
  model and an effort (`docs/boundary-api.md`, 「How a gate run reaches a model」).
- **A gate whose profile names a forwarding key** goes out under that key instead wherever the agency serves it:
  each run asks the agency for the key (`GET /work-keys/{key}`), and where it answers, the run's mode, its
  mapping and its turn are the key's; where it answers none, the run goes out under the gate's own key. The
  translator forwards to `translate`, the agency's translator runner line, so the translation moves onto that
  line the moment the agency serves it, with no change here.

## Each agent's own gates

- **Every agent that answers in a room passes the gates its own turn passes,** and the turn declares which:
  the chat agent's turn the pre-gate and post-gate parts of the gate order above, a companion's turn the
  gates that pick its reference and the outgoing sanitizer (the agency's `docs/companions.md`). An agent
  that answers in no room has none.
- **Each such agent has a switch of its own for each of those gates,** kept by the agency under the agent
  and the gate, which the receiver hands the gate as a turn's `off`. A gate is on for an agent until it is
  switched off there, so an agent added later starts with every gate of its turn on, and its deployment may
  start it with some off.
- **A gate standing in both parts is one switch,** as on the console's tables: the sanitizer switched off for
  an agent is off before its answer and after it.
- **A gate switched off for an agent is never asked in that agent's turns:** no run, no judgement and no
  tokens under it. Another agent's turn in the same room passes it as its own switch says. The turn goes on
  without it:
  - a reference gate, `people-search` or `situation-rules` adds nothing to the turn's reference, and
    `room-memories` leaves the memories entry to the due rows alone;
  - `session-summary` lets the replaced session go with no summary carried over;
  - the sanitizer leaves the text as it was written, and the code's own dash replacement of the outgoing
    clean still runs;
  - `output-format` leaves the fold to the code, as on a send that asks no gate.
- **A gate on for the turn with nothing to ask about is not asked either, but says so** (「What a turn
  records」).
- **What no agent's turn carries is not switched here:** the off-turn gates, and the sanitizer and the output
  gate on a message the chat agent sends outside any turn.
- **Where the switches are turned:** the console's agent management screen and the agent's own settings,
  through the agency's `POST /agent-gate` (the agency's `docs/api.md`).

## What a turn records

- **Every gate a turn asks leaves its judgement** under the message it was asked for, which the console shows
  as the turn's verdict chip (`GET /judgements?roomId=`).
- **A judgement's verdict opens with its keyword:** one upper-case word, which the console reads the chip's
  colour and the end of judging by (the web unit's `docs/web.md`, 「Room screen」), and after it, past a colon,
  what was decided. What the model answered, or why it gave nothing, stands in the judgement's detail and never
  as its verdict. The reference gates (`system-documents`, `room-rules`, `library-knowledge`), `people-search`,
  `room-memories` and `situation-rules` write these, on every road alike:

  | Verdict | When |
  |---|---|
  | `PICK: <slug>, <slug>` | a picker's answer was read and named these: answered yes, or for `people-search` named |
  | `MATCH: applies=<slugs> spent=<slugs>` | the matcher's answer was read and at least one rule applies or is spent; an empty side reads `none` |
  | `NONE` | the answer was read and picks or matches nothing |
  | `UNREADABLE` | an answer came, but not in the shape the gate was asked for, so it is not read (`docs/reference-selection.md`, 「What the three reference gates are asked, and what they answer」) |
  | `NO-ANSWER` | the road gave no answer: it failed, or the gate's wait ran out |
  | `SKIP: no candidates` | the gate was on but not asked (below) |

  A decision on Laya is written the same way whoever settled it — Laya, the fallback LLM or the default — and
  its detail says which, and where Laya gave no verdict why: its failure kind, a busy card with the reason the
  engine gave, as `busy: the card is taken for <claim>` (`docs/laya.md`, 「A gate whose provider is Laya」).
- **Their judgements carry the lines the model was asked of their candidates, each with what it answered of
  it,** so the room's log shows exactly what the model read beside what it said. A line is written as the model
  read it, character for character, in the order it read them, and its answer is null where the answer was not
  read (`UNREADABLE`, `NO-ANSWER`):

  | Judgement | Its lines | Each line's answer |
  |---|---|---|
  | a run of a picker's model | each candidate's index line, as the request's index carries it | `yes` or `no`; for `people-search`, `yes` for a candidate it named and `no` for one it passed over |
  | a run of the matcher's model | each rule's line, as the request's rules carry it | `applies: <yes\|no>, spent: <yes\|no>` |
  | a decision on Laya | each question Laya was asked: a picker's one per candidate, the matcher's two per rule (`docs/laya.md`, 「Each gate's probe」) | `yes` or `no` where Laya settled it; null where its fallback LLM or the default did, whose own run judgement carries the lines that model read |

  A candidate is named in its line by the name the gate offers it under, which is the name its answer and its
  verdict record keep. Every other judgement carries no lines.
- **A reference gate, `people-search`, `room-memories` or `situation-rules` that is on for the turn but has no
  candidate left once the code has narrowed them** — a room with no rulebook, an agent with no knowledge of its own, a turn
  no situation rule of the room is open for — is not asked, and leaves the judgement `SKIP: no candidates` in
  its place, so the chip shows every gate the turn had on and why one stood aside. A reference gate,
  `people-search` and `room-memories` leave beside it their row of the offers record, asked about none, which is how many
  candidates the narrowing started from and by which rules it narrowed (`docs/reference-selection.md`,
  「What the code narrows before a gate is asked」).
- **A gate switched off, or one the turn does not ask by its own declaration** (a turn of the chat agent's
  own lines alone for a gate that never reads them, a turn with no text), leaves nothing.
- **A round's draft process is the `draft` stage** (the receiver's `docs/drafting.md`): the gate writes one
  judgement for each row of it the receiver tells (`docs/boundary-api.md`, 「bmo-receiver」), and judges nothing of
  what was asked or answered. `draft` is no gate: it stands in no part of the gate order, runs no model and has no
  options. Every row the receiver tells leaves one judgement, whatever its kind and whatever its number, and no
  row is waited for or taken to stand before another:

  | Verdict | Row |
  |---|---|
  | `ROUND <number> <name>: <outcome>` | any row but the end — a turn, a question, an item or a check: its number in the process, its question's name, or its kind where it names none, and how it ended (`answered`, `skip` or `failed`) |
  | `END: <outcome>` | the end: `message`, `skip`, `withheld`, `ceiling-message` or `ceiling-skip` |

  Its detail is `answerChars=<n> changed=<true|false> ms=<n>`, and after it, past a semicolon, what the receiver
  said of the row where it said anything: for the end, the row of the process table the turn read and the checks
  that withheld the text. The judgement carries the round, stands in the round's room, and is put under the
  round's message the way the round's other judgements are: where one of the round's judgements already stands
  under a message it is written under that message, and otherwise it waits for the receiver's attach
  (`docs/api.md`, 「Judgements」). A round that sent nothing leaves its rows under no message.
