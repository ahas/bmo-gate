# The gate's boundary

This document is the gate's boundary: where its served routes are stated, every call it makes on another
unit, the unit command it carries, and what it owns. A unit reaches the gate only across it, and the gate
reaches another unit only by the calls below. A route or a call that is not in `docs/api.md` or here is not
part of the boundary.

The gate is the gate stage of a turn. The receiver builds a turn's envelope; the gate summarises a replaced
session, hands the turn what attaches with no pick and serves the brain's index the agent reads the rest
through, and checks the answer on its way out; the agency carries the turn; the brain serves the rows. Beside
a turn the gate translates for the units that ask, and it records every judgement it makes and the road each
run walked. Laya, the decision filter some gates ask
first, is the gate's own service, reached through the gate's own relay.

## Configuration

The service reads one TOML file at start and holds it for its life: the release's own `settings.toml`, which
each release links to the data root's `env/gate.toml`. It names:

| Key | What it is |
|---|---|
| `listen` | the address the service answers at |
| `address` | the base address the service is reached at, which its `health` asks |
| `token_file` | the name of the file under the data root's `env/` holding the bearer token every caller presents |
| `database` | the address of the gate's own database, holding the tables under 「What the gate owns」 and nothing else |
| `data_root` | where the gate's runtime data lives: Laya's checkpoints, datasets and run output, and the gate's run files |
| `chat_agent` | the registration name whose gate options stand for the deployment, and which a companion's are copied from |
| `run_agent` | the registration name a gate run's own session stands under, so its program keeps a place apart from the agent whose turn it judges; absent, the caller's agent stands, or the stage's name where the caller names none |
| `session_folder` | the folder a gate run's thrown-away session is started in |
| `[agency]`, `[brain]`, `[receiver]` | each unit's `address`, and the `token_file` under `env/` holding the token it is called with |
| `[arbiter]` | the card master's `address` |
| `[gateway]` | the agency's model gateway: its `address`, and the `key_file` under `env/` |
| `[laya]` | the gate's own Laya relay, where one stands: its `address`, and the `token_file` under `env/` |
| `[shipped]` | `folder`, under which the shipped pieces' bodies are read — the system's reference documents, as the deployment places them — a row's path read relative to it |
| `[reading]` | what the translator's checks read a text by: `set_aside`, the words the English test reads past — the names of people and agents and the marks a note's strands open with — and `wording`, the file the owner's banned words are read from, where the deployment keeps one |

No address, port, host, path or name of a deployment is written in the code; every one is read from here.

## Routes served

`docs/api.md` states every route the gate serves, one section per resource, in the common wire format: camelCase
keys, epoch milliseconds, signed 64-bit ids, `{code, error}` on a non-2xx answer, and a page of `items` and
`more`. No section of that document is written for one caller, and no route names one. The gate serves no
console screen: a console reads its routes as any caller does.

- **Records.** `bmo-gate records <table>` prints every row of one of the gate's own tables, from the database the
  settings name or the one `--db` names, one JSON object a line with every column under its own name, in the
  order the rows were written. It is how the training tooling reads the gate's own records into its
  conversation snapshot (`docs/gate-data.md`, 「The conversation source」). A name that is not one of the gate's
  own tables ends with 2. It reads and writes nothing else, and like `health` it is no noun, so `nouns` does not
  declare it.

## Calls the gate makes

### bmo-brain

In the common conventions: camelCase, epoch milliseconds, and an error of `{code, error}`. The reads are
`GET` and the writes `POST`. These are the calls the gate's hand-written port makes on the brain's brains
(the brain's `docs/boundary-api.md`, 「Brains」); the brain's published client does not carry the reference
road's view of the rows.

The gate finds the turn's agent's brain once, by the agent's key, and reads that brain's memories by type:
one memory is one row of a type about subjects, and the gate maps it to what the reference road reads. A
row the data move brought keeps its old fields in `labels`, which the mapping reads where they stand; a row
the agent wrote itself is read from its subjects: its room is its `room` subject, its person its first
`person` subject, its slug its key or its id. A row is read in a room where it is about that room or about
no room at all.

| Call | Route | Body or query | Answer |
|---|---|---|---|
| the agent's brain | `GET /brains` | `agentKey`, `limit=2` | `items`: the one brain of that agent key, whose id every call below stands under |
| standing rows | `GET /brains/{brainId}/memories` | `type` (each of `promise`, `check`, `followup`, `situation`, `state`), `status=active`, `limit` at the route's ceiling, `after` for each page after the first | `items`: the rows that wait on nothing, by their old `conditions` label or, for a `situation` the agent wrote, its own text, and the errands whose event has come, by their `event_met_at` label; a row's words are its old condition's action, else its text |
| conditional rows | the standing rows | | their old `conditions` label, or a `situation`'s text as its condition |
| rows the events wake | the standing rows | | the gate filters them by the events their `event` or `conditions` labels name |
| fragments offered | `GET /brains/{brainId}/memories` | `type` (the brain's type for the reference kind: `knowledge`, `rule`, `lore`), `status=active`, paged | `items`: the rows read in the room, each mapped to a fragment row whose key and version are the memory's id |
| people offered | `GET /brains/{brainId}/tallies` | `type=fact`, `status=active`, `by=subject` | the subjects the brain's live facts are about, each `group` a subject's id; the index's `people` group lists one entry for each of them that is a person (below) |
| people named | `GET /brains/{brainId}/subjects` | `ids`, those subjects' ids, comma-separated; `limit` at the route's ceiling | `items`: each `id`, `type`, `key` (a person's user id) and `name` |
| lore sections | `GET /brains/{brainId}/layers` | `limit` at the route's ceiling, `after` the largest id read for each page after the first | `items`: the brain's layers, each `id`, `name` and `position`; a lore row's section is its layer |
| knowledge read | `GET /brains/{brainId}/memories` | `type=knowledge`, `status=active`, paged | `items`, filtered by the slug asked |
| lore read | `GET /brains/{brainId}/memories` | `type=lore`, `status=active`, paged | `items`, filtered by the slug asked; a piece's body is the row's text |
| a subject found | `GET /brains/{brainId}/subjects` | `type` (`person` or `room`), `key` (the user's or the room's id), `limit=1` | `items`: the subject, or none where the brain holds none |
| a person's sheet | `GET /brains/{brainId}/subjects/{subjectId}/sheet` | `roomId`, the room's subject, where the brain holds one; `limit`, the head's line count, for a speaker's head (`docs/reference-selection.md`, 「What a turn is given」), and none for a whole sheet | `text/plain`: one line a fact, `- [#<id> since <date>] <text>`, the most important first; empty where the brain knows no fact of the person there |

The system's reference documents are held nowhere in the brain, so the brain answers no rows of them, and the
shipped folder holds their bodies alone. The lore is the agent's brain's: memories of type `lore`, each
in a layer named `lore` or `lore/<section heading>` (the brain's `docs/design.md`, 「Persona and lore」),
listed in a room that reads the lore and in no other. Each row is one entry: its slug is the part of its key
after `lore/`, what it holds its `title` label with its `scope` label where it carries one, its section its
layer's name, and its body its text. The rows stand in their layers' positions and, within a layer, in their
own.
A person is read through their sheet, never through a row: the brain holds no memory of type `sheet`, and
the gate reads none. A speaker's head and a person's piece read from the index are both that person's sheet as
the brain renders it with the turn's room as its room — their facts about no room and their facts about that
room (the brain's `docs/design.md`, 「A person is a subject」) — held to the reference's ceiling for a sheet
(`docs/reference-selection.md`, 「What a turn is given」). An entry of the `people` group is one person subject
the brain's live facts are about: its slug `person-<user id>`, what it holds the subject's name, else the user
id. The brain picks nothing, and the gate writes nothing back to it.

### bmo-receiver

The receiver's event stream, which the gate reads the rows of each round's draft process off.

| Call | Route | Body or query | Answer |
|---|---|---|---|
| draft rows | `GET /events`, held open | none | the receiver's event stream; the gate takes the frames whose data's `type` is `draft` and lets every other go |

A `draft` frame of a row is one row of a round's draft process as the receiver's round log keeps it (the
receiver's `docs/drafting.md`, 「The round log」): `chatId`, `round`, `agentName`, `number` (from 1, the round's own
turn being the first question's row), `question`, `kind` (`turn`, `question`, `item`, `check` or `end`),
`answerChars`, `changed`, `outcome`, `detail`, `ms` and `at`, and never the answer itself. A `draft` frame of kind
`start` is no row: it tells a question as it starts, with `number`, `count` and `question` and none of a row's
answer fields, and the gate lets it go by its `kind` before it reads a row. The gate writes each row into its
judgements as the `draft` stage (`docs/gates.md`, 「What a turn records」). The stream replays the receiver's ring
of recent events each time it is opened, and the gate opens it again five seconds after it drops; a row the gate
has written already is not written twice, and a row that left the ring while the stream was down is not written
at all.

### bmo-agency

In the agency's conventions (its `docs/api.md`): camelCase, the agency's control token.

| Call | Route | What the gate needs it for |
|---|---|---|
| the agents | `GET /agents` | the registrations a gate run names and the agents a turn is for |
| shared rulebooks | `GET /rulebooks?names=` | `recollection`, the rulebook the session summariser stands on |
| the providers | `GET /providers` | the provider order a gate's road begins on and whether each is on |
| a gate's route | `GET /work-keys/{workKey}` | the run mode the gate's work key stands on (`docs/gates.md`, 「Where a gate's runs go out」) |
| a mapping | `GET /work-keys/{workKey}?provider=&tier=` | the `provider`, `model`, `effort` and `answerTokens` a gate run goes out on |
| a stand-in | `GET /agents/{agentName}` | `standInAvailable`, whether a stand-in answers while Claude Code's road is closed |
| a session | `POST /sessions` | `agentName`, `scope` `conversation`, `options` `{provider, model, cwd}`: one thrown-away conversation for one gate run on a provider's program |
| a turn | `POST /sessions/{sessionId}/turns` | `prompt`, and the `gate` part: `system`, the gate's whole system prompt; `thinking`, whether the run thinks; and `model`, `effort` and `answerTokens`, the mapping its tier resolved to |
| a session ended | `DELETE /sessions/{sessionId}` | a run of the gate's somebody stopped, its turn cut short |
| a session's loads | `GET /session-loads/{sessionId}` | `documents`, each `path` and `version`: what the session was handed in full, which the index counts read |
| a session's loads kept | `PUT /session-loads/{sessionId}` | `documents`, every load the session now holds, the piece just read added at its version |
| a translation | `POST /translation-runs` | `purpose` (`document`, `worker` or `record`), `language` (the target's name as the policy names it) and `text`, one part: answered with `text`, the part translated whole, and the `provider` and `model` it went out on (「The translation line」) |
| the events | `GET /events?kinds=road-walked` | the road each conversational turn walked, which the gate writes into its road records |

The gate registers no hook at any of the agency's hook points and answers none.

### The translation line

- **Every translation the gate makes is one ask of the agency's translation line,** `POST /translation-runs`, a
  part at a time: the agency runs it as a run apart on its `translate` work key, under the instructions of the
  purpose asked, which are the agency's (its `docs/launch-lines.md`, 「Translate runner」). The purpose is
  `document` for a part of a document the viewer asked for, `worker` for a text read into the worker's language
  and `record` for a worker's record read into the owner's language.
- **What stays the gate's:** the translations route, the kept translations, a document's queue, the cutting into
  parts, the structure each answer is held to and the asks again, how many parts stand out at once, and the
  halving of a part too large for the line's road: a part the line refuses as past its road's window is cut in
  two, at a paragraph else a line, each half asked on its own and the two joined in order, a half with no answer
  leaving the part unanswered. Any other refusal leaves the part unanswered.
- **What is the agency's:** the road each translation walked and what it spent, kept in the agency's ledger; the
  gate keeps of a document's translation only its rows and, where a part failed, why.

The training tooling's claude road hands a batch to the agency's command for a run apart, as the tooling's settings
name it (`docs/gate-data.md`, 「The claude road」), with `--model`, `--effort`, `--config-dir`, `--system-file`,
`--title` and `--bound-seconds` after it, the batch on its standard input, and one JSON object back: `text`,
`model` and `spend`, each model's `inputTokens`, `outputTokens`, `cacheReadTokens` and `cacheWriteTokens`.

### The model gateway

A gate run on a registered model has no tools and no session: it is one request to the gateway's
`/v1/chat/completions`, the registration's name as its model, the gate's instructions as the first message,
the input, `max_tokens` and `enable_thinking` as the run says, and the caller's wait in the gateway's
per-request wait headers (the agency's `docs/own-llm.md`, 「A request with no tools」, 「The gateway」). The
key is read from its file for each request.

### The Laya relay

The gate's own relay, `laya-relay` (`docs/laya.md`), which hands a call to the first node of the service's
placement able to take it: `POST /decide` with `gate`, `state` and `questions`, answering each question's
verdict and its confidence, and `GET /health` for the health row. The relay hands both on to the front on the
node, and the front to the decision server behind it.

### bmo-arbiter

| Call | Route | What for |
|---|---|---|
| a placement | `POST /place`, `POST /remove` (the card master) | `service` (`laya` or `laya-train`) and `node`: moving the Laya service or its training to a node; the answer is the master's lines, the last `== done` or `== failed: <why>` |
| the units' description | `PUT /descriptions/{service}` (the card master) | `units`: what the Laya service says of its units on a card |
| a card turn | `POST /turns`, `GET /turns/{ticket}`, `DELETE /turns/{ticket}` (the node arbiter, on the node's loopback) | the Laya server's and the training's hold on the card, asked by the gate's own turn client on the node, `runtime/laya-server/turn.py` |

### bmo-node

The training tooling and the Laya service's installer reach a node by its registered name through the node unit's
command, as the tooling's settings name it (`docs/training.md`, 「The tooling and its settings」): `node --target
<node>` prints the node's connection as JSON (the node unit's `docs/nodes.md`, 「Registering and changing a
node」), its connection type with an ssh node's address, port, account, key path and shell, or a hub node's agent,
hub and token file, and its role. No credential is in it. A hub node is then driven through the node console the
settings name, an ssh node by a batch login.

## How a gate run reaches a model

Gate runs are the gate's own: the agency starts none and holds no gate's line. A translation is no gate run: the
gate asks the agency's translation line, which the agency runs as a run apart (「The translation line」). A gate
runs on its one road, one ask and nothing behind it (the agency's `docs/own-llm.md`, 「A gate has one road」):

- **The road** is the gate's work key's run mode where it names a provider that is on, else the first provider
  on in the provider order; the mapping comes from `POST /routes/resolve` at the tier the gate's profile names.
  A run its caller puts on another provider or on one registration goes there alone.
- **A provider whose program carries the run** — Claude Code, Codex, OpenRouter, every provider the agency
  does not mark `registered` — is a thrown-away agency session each run: started apart on the provider and
  model, sent one turn with the gate's instructions as its whole system prompt, a fresh session, no tools, and
  thinking as the run asks. The gate knows no pane, no terminal and no backend.
- **A provider whose models are registrations** is one request through the agency's model gateway, on the
  registration the mapping names. A request the gateway refuses as past the registration's window is cut by
  its caller where the caller can cut it, each part asked on its own, and is the gate having no answer
  otherwise.
- **Laya** is one call to the relay. A gate whose provider is Laya asks its fallback LLM once where Laya gave no
  verdict, on that LLM's own road.
- **What a run walked** is written into the gate's road records, and what it spent is the agency's `usage-spent`.

## What the gate owns

### Its tables

`gate_options`, `gate_roads`, `judgements`, `laya_health`, `laya_verdicts`, `reference_offers`,
`reference_verdicts`, `document_translations`, `format_cases` and `web_gate_chats`, in its own database and its
own migrations. Every row of `gate_options` names its agent. `reference_offers` and `reference_verdicts` hold
records the history reads (`docs/api.md`, 「Judgements」) and nothing writes. A format case is kept ninety days:
the service sweeps the table as it starts and once a day after.

### Its gates and their instructions

- **The gate order** — which gates stand, the part and step each takes against a turn, and each gate's profile
  (whether it may be switched off, its Laya probe and default mode, its answer floor) — is the gate's, and
  `GET /gates` serves it.
- **The instructions,** three files in two folders, one folder a gate: `output-gate/telegram-html` and
  `session-summary` (two).

### The policy it reads

| Values | Owner | How the gate reads them |
|---|---|---|
| the gate pool: how many runs of one gate stand at once | the gate | its own policy file |
| the output gate's folding dialects and checks | the gate | its own policy file |
| what a turn is handed: the sheet's head and ceiling, the due memories' count, the woken rows' and the turn's totals | the gate | its own policy file |
| the memories entry's lines | the gate | its own policy file |
| the session summariser's transcript and summary: their lengths and the line the transcript rides under | the gate | its own policy file |
| the gate order and the gates' profiles | the gate | its own policy file, served by `GET /gates` |
| the prompt ceilings | the gate | its own policy file |
| the translator's languages: the worker's, the owner's and each language's name | the gate | its own policy file |
| a work key's tier, mapping and run mode | the agency | `POST /routes/resolve`, `GET /fallback` |
| the keepalive's ping bound | the agency | not read: a gate run keeps no session |
| a resident turn's shape | the agency | not read: a gate run is no resident turn |
| OpenRouter's settings | the agency | not read: a run reaches OpenRouter through the agency |
| filling a template's marks | none | the gate's own code |

## The unit command

`bmo-gate` is the gate's unit command (bmo-cli's `docs/boundary.md`, 「Unit commands」). Asked `nouns`, it
declares the nouns it carries, one a line. These are its four nouns:

| Noun | What it does |
|---|---|
| `gate eval` | runs the gate evaluation set over a gate and scores it |
| `gate bench` | benches a gate's road against recorded turns |
| `gate laya-agreement` | counts each Laya gate's agreement with its LLM |
| `gate format-cases` | reads the output gate's format failure cases |

- **Every noun prints English** and ends with 0, with 1 where its work failed, and with 2 where the words it was
  given are wrong; `--help` prints a noun's whole usage.
- **It reads the settings the service reads** (「Configuration」): the file `BMO_GATE_SETTINGS` names, else
  `settings.toml` in the folder it runs in. A noun that reads nothing but its own files under the data root
  reads only the data root from them.
- **It is the gate's own,** so it reads the gate's database and data root as the service does, and reaches the
  other units only through the routes above. A noun that reads another unit's records whose owner serves no
  route for them says so and reads nothing in their place.

The service binary itself is `gate-server`, which is installed under no `bmo-` name.

## Versioning

The version stands in `VERSION`. A change that takes a field, a route or a code away from this boundary, or
changes what one means, is a major change; a change that adds to it is a minor one; a change inside the gate is a
patch.

## Contract gaps

Statements here that a sibling's document does not yet match, each for that sibling to take up:

- **The agency names the gate among the registrants of its `turn-submitting` hook point** (the agency's
  `docs/api.md`, 「hooks」); the gate registers no hook (「bmo-agency」 above), for the agency to drop the name.
- **No unit asks the session summariser:** the agency keeps no session summary (its `docs/sessions.md`) and
  resolves no road for the `session-summary` work key, so the gate's `session-summary` stands in the gate order
  and the evaluation set and runs only there, until the owner retires it or a unit asks it again.
- **The brain's layers are listed by position but paged after the last id seen,** so a page boundary can
  pass over a layer whose id is lower than one already read. The gate reads the layers at the route's
  ceiling of a page and asks each later page after the largest id it has read, until the brain pages its
  layers in the order it lists them.
- **The agency publishes no command that runs one batch apart** with the words the training tooling's claude road
  hands it (「bmo-agency」 above); the road runs whatever command the tooling's settings name until the agency
  states one.
- **The upstreams' published clients do not carry the calls the gate makes.** bmo-brain's client serves memory
  rows, notes, watches, reminders, fragments and libraries, and not the subject, sheet and tally routes the gate
  reads; bmo-agency's client serves sessions and turns, and not the work-key route the gate resolves. The
  gate's hand-written ports in `crates/ports` stand for these calls until their owners serve them, and the
  gate takes the client of each one as soon as it does.
- **No unit but the gate serves its part of the training tooling's conversation snapshot:** the receiver's messages
  and sent messages, the agency's run log, bmo-job's items and job runs, and bmo-artifact's searches stand
  unavailable in every snapshot (`docs/gate-data.md`, 「The conversation source」) until each owner serves a route
  for its part.
- **The agency keeps copies of gate-owned files:** the gate order (its `policy/gates.toml` and the policy crate's
  module of it), the prompt ceilings (its `policy/gate-prompts.toml` and its module), and gate instruction files
  under its `prompts/agents/`. Its gate switch route validates a gate's name against its own copy of the order;
  the copies are for the agency to retire, reading the order through `GET /gates`.
- **No chat unit asks the output gate yet:** the telegram unit's send path folds a reply's parts by its own
  code; it is to ask `POST /formats/decided` for each part where the send asks for the gate.
- **The brain's knowledge read** answers the knowledge chunks a room may read; the gate reads a room rule's piece
  through it as well, for the brain to take the room's room-rule chunks there.
- **The receiver sends no `lore`** with a turn's reference, so every room's index lists the lore.
- **The document viewer counts a part kept as failed and says no more:** the parts page answers each such part's
  `failure` (`docs/api.md`, 「Documents」), for the web unit to show beside the count.
- **The receiver serves no route for a room's latest messages:** the output gate's replay bench makes its set out
  of the chat agent's latest answers, and says the source is unavailable until the receiver serves them
  (`docs/output-gate.md`, 「The replay bench」).
