# The gate's boundary

This document is the gate's boundary: where its served routes are stated, every call it makes on another
unit, the unit command it carries, and what it owns. A unit reaches the gate only across it, and the gate
reaches another unit only by the calls below. A route or a call that is not in `docs/api.md` or here is not
part of the boundary.

The gate is the gate stage of a turn. The receiver builds a turn's envelope; the gate hands the turn what
attaches with no pick and serves the brain's index the agent reads the rest through; the agency carries the
turn; the brain serves the rows. Beside a turn the gate translates for the units that ask, and it records every
judgement it is told and the road each run walked. The gate order holds no gate: the agent formats its own reply
and keeps its own session (`docs/gates.md`).

## Configuration

The service reads one TOML file at start and holds it for its life: the release's own `settings.toml`, which
each release links to the data root's `env/gate.toml`. It names:

| Key | What it is |
|---|---|
| `listen` | the address the service answers at |
| `address` | the base address the service is reached at, which its `health` asks |
| `token_file` | the name of the file under the data root's `env/` holding the bearer token every caller presents |
| `database` | the address of the gate's own database, holding the tables under 「What the gate owns」 and nothing else |
| `data_root` | where the gate's runtime data lives: its files and the tooling's settings |
| `chat_agent` | the registration name whose gate options stand for the deployment, and which a companion's are copied from |
| `run_agent` | the registration name a gate run's own session stands under, so its program keeps a place apart from the agent whose turn it judges; absent, the caller's agent stands, or the stage's name where the caller names none |
| `session_folder` | the folder a gate run's thrown-away session is started in |
| `[agency]`, `[brain]`, `[receiver]` | each unit's `address`, and the `token_file` under `env/` holding the token it is called with |
| `[accounts]` | the account service, bmo-web's server, in the same shape; absent, no org brain is read (`docs/reference-selection.md`, 「What an organisation hands its members」) |
| `[gateway]` | the agency's model gateway: its `address`, and the `key_file` under `env/` |
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
  order the rows were written. A name that is not one of the gate's own tables ends with 2. It reads and writes
  nothing else, and like `health` it is no noun, so `nouns` does not declare it.

## Stopping

The service stops on SIGTERM or an interrupt, and the unit's stop waits for it to end.

- **It takes no new connection** from the moment the signal comes, and a connection held idle between calls is
  closed.
- **Every open event stream is told,** with an `event: stopping` frame carrying no id (`docs/api.md`, 「Events」),
  and then ends, so a reader opens it again against the service that comes next rather than waiting on one that
  is gone.
- **The calls in hand are let finish within thirty seconds** of the signal. The service ends once the last of
  them has answered, or when the thirty seconds have passed with a call still open, which then ends unanswered
  with its connection; a caller asks it again of the service that comes next.
- **What the watches hold is not lost:** a road the agency's stream told is written with its number, so the
  stream is read on from the newest number written (「The roads walked」), and the receiver's draft rows are
  replayed from its ring.

## Calls the gate makes

Every call below waits for its answer. Its end is the answer, a refused or broken connection, or the other unit
gone; no call carries a timeout, and a refused connection ends the call where it stands, the gate's answer
saying which unit did not answer, but for a translation run, which is asked again until the agency answers
(「The translation line」). The two event streams the gate holds open, the receiver's and the agency's,
are opened again after they drop.

### bmo-brain

In the common conventions: camelCase, epoch milliseconds, and an error of `{code, error}`. The reads are
`GET` and the writes `POST`. These are the calls the gate's hand-written port makes on the brain's brains
(the brain's `docs/boundary-api.md`, 「Brains」); the brain's published client does not carry the reference
road's view of the rows.

The gate finds the turn's agent's brain by the account that owns the agent and the agent's key, of the kind `agent`
(`docs/reference-selection.md`, 「Whose reference it is」), remembers it once found, and reads that brain's
memories by type:
one memory is one row of a type about subjects, and the gate maps it to what the reference road reads. A
row the data move brought keeps its old fields in `labels`, which the mapping reads where they stand; a row
the agent wrote itself is read from its subjects: its room is its `room` subject, its person its first
`person` subject, its slug its key or its id. A row is read in a room where it is about that room or about
no room at all.

| Call | Route | Body or query | Answer |
|---|---|---|---|
| the agent's brain | `GET /brains` | `kind=agent`, `agentKey`, `accountKey` where the agent's supervisor has an account (the owning user's id), `limit=2` | `items`: the brain of that account and agent key, whose id every call below stands under; with no account asked, the one brain of that agent key, and none where the key stands in two accounts or more; where none is answered, every read below answers nothing |
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
| a unit's org brain | `GET /brains` | `kind=org`, `accountKey` the company's number, `agentKey` the unit's, `limit=1` | `items`: the unit's org brain, remembered once found, or none, where the unit is passed over |
| what stands for a person | `GET /org-topics` | `brainIds`, the org brains of the person's units, the farthest first; `audience`, `internal` or `external`, always named, the room's audience (`docs/reference-selection.md`, 「What an organisation hands its members」) | one item a topic: `topic`, `brainId`, the brain whose word on it holds, `locked`, and its `memories`, each `id`, `text`, `importance`, `locked` and `internalOnly`; for `external`, a memory whose `internalOnly` is true or absent is left out |
| a unit's org memories | `GET /brains/{brainId}/memories` | `status=active`, `excludeTypes=rumor,episode`, paged | `items`: every live org memory of the unit that is neither a proposal nor an episode, each `id`, `text`, `recallCondition`, `subjects` (a topic is a subject of type `topic`, its key the topic), `validFrom` and `internalOnly`, a memory whose `internalOnly` is absent read as internal-only; no type is named, so the read records no use |
| a person's sheet | `GET /brains/{brainId}/subjects/{subjectId}/sheet` | `roomId`, the room's subject, where the brain holds one; `limit`, the head's count of fact lines, for a speaker's head (`docs/reference-selection.md`, 「What a turn is given」), and none for a whole sheet | `text/plain`: one line a name first, `- [#<id> name] <text>`, those about the room ahead of those about no room, every name whatever the `limit`; then one line a fact, `- [#<id> since <date>] <text>`, the most important first; empty where the brain knows no name and no fact of the person there |

The system's reference documents are held nowhere in the brain, so the brain answers no rows of them, and the
shipped folder holds their bodies alone. The lore is the agent's brain's: memories of type `lore`, each
in a layer named `lore` or `lore/<section heading>` (the brain's `docs/design.md`, 「Persona and lore」),
listed in a room that reads the lore and in no other. Each row is one entry: its slug is the part of its key
after `lore/`, what it holds its `title` label with its `scope` label where it carries one, its section its
layer's name, and its body its text. The rows stand in their layers' positions and, within a layer, in their
own.
A person is read through their sheet, never through a row: the brain holds no memory of type `sheet`, and
the gate reads none. A speaker's head and a person's piece read from the index are both that person's sheet as
the brain renders it with the turn's room as its room — their names, then their facts about no room and their
facts about that room (the brain's `docs/design.md`, 「A person is a subject」) — held to the reference's ceiling
for a sheet (`docs/reference-selection.md`, 「What a turn is given」). An entry of the `people` group is one person subject
the brain's live facts are about: its slug `person-<user id>`, what it holds the subject's name, else the user
id. The brain picks nothing, and the gate writes nothing back to it.

### The account service

bmo-web's server (its `docs/boundary.md`, 「Organisation units」), in its wire conventions: camelCase, its server's
token, a user named by the digits of their id.

| Call | Route | Body or query | Answer |
|---|---|---|---|
| a person's unit | `GET /users/{user}/unit` | | `company` and `path`, the unit references from the company down to the person's home unit, each `id` and `name`; 404 is a person the service places in no unit, who reads no org brain |
| a person's posts | `GET /users/{user}/posts` | `Owner-Key`, the person's own id | `posts`, each `unit` and its `path` from the company down to it |

The gate asks both for the owner of the supervisor whose reference it reads, on every turn and every read of the
index, and keeps neither answer, so a person moved between units reads their new units at once.

### bmo-receiver

The receiver's event stream, which the gate reads the rows of each round's draft process off, and a room's audience.

| Call | Route | Body or query | Answer |
|---|---|---|---|
| draft rows | `GET /events`, held open | none | the receiver's event stream; the gate takes the frames whose data's `type` is `draft` and lets every other go |
| a room's audience | `GET /rooms/{roomId}/audience` | `agent`, the supervisor the read is for | `room`, `agent` and `audience`: `external` where someone outside the company of the agent's owner sits in the room, or who sits there could not be read, `internal` where everyone there is of it; 404 `not-found` for a room the receiver does not hold, 400 for a blank `agent` |

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

The gate asks a room's audience on a read of the index, a piece or a search that names none, where the
`organisation` group is read and the supervisor's owner stands in a unit keeping an org brain, once a call; it
keeps no answer. Where the call fails, refused, unanswered or answered with an audience other than the two, the
read is `external` and the gate logs why (`docs/reference-selection.md`, 「What an organisation hands its members」).

### bmo-agency

In the agency's conventions (its `docs/api.md`): camelCase, the agency's control token.

| Call | Route | What the gate needs it for |
|---|---|---|
| the providers | `GET /providers` | whether each provider is on, and whether its models are registrations or served on the agency's gateway, which decides how a gate run reaches its model |
| a gate's role | `GET /roles/{roleName}` | the role a gate's profile names (`docs/gates.md`, 「Where a gate's runs go out」): `provider`, its active provider or null, and `order`, each entry's `provider`, `model`, `effort`, `thinking` and `answerTokens`, which a gate run goes out on; 404 `not-found` is a role the agency does not hold |
| a session | `POST /sessions` | `agentName`, `scope` `conversation`, `options` `{provider, model, cwd}`: one thrown-away conversation for one gate run on a provider's program |
| a turn | `POST /sessions/{sessionId}/turns` | `prompt`, and the `gate` part: `system`, the gate's whole system prompt; `thinking`, whether the run thinks; and `model`, `effort` and `answerTokens`, what its role's order names on the run's provider |
| a supervisor's owner | `GET /supervisors/{supervisorName}` | `ownerAccount`, the id of the user whose account owns the supervisor, null for the deployment's own; a name the agency holds no supervisor of (404 `not-found`) is read as no account. The account decides whose brain a reference is read from (`docs/reference-selection.md`, 「Whose reference it is」) |
| a session's loads | `GET /session-loads/{sessionId}` | `documents`, each `path` and `version`: what the session was handed in full, which the index counts read |
| a session's loads kept | `PUT /session-loads/{sessionId}` | `documents`, every load the session now holds, the piece just read added at its version |
| a translation | `POST /translation-runs` | `purpose` (`document`, `worker` or `record`), `language` (the target's name as the policy names it), `text`, one part, and `note` where the gate has a word on that part: answered with `text`, the part translated whole, and the `provider` and `model` it went out on; 413 `too-large` for a part past the model's window (「The translation line」) |
| the events | `GET /events?kinds=road-walked`, with `Last-Event-ID` | the road each conversational turn walked, which the gate writes into its road records, read on from the last one written (「The roads walked」) |

The gate registers no hook at any of the agency's hook points and answers none.

### The translation line

- **Every translation the gate makes is one ask of the agency's translation line,** `POST /translation-runs`, a
  part at a time: the agency runs it as a run apart on its translator role's provider order, under the instructions
  of the purpose asked, which are the agency's (its `docs/launch-lines.md`, 「Translate runner」). The purpose is
  `document` for a part of a document the viewer asked for, `worker` for a text read into the worker's language and
  `record` for a worker's record read into the owner's language.
- **What stays the gate's:** the translations route, the kept translations, a document's queue, the cutting into
  parts, the structure each answer is held to and the asks again, how many parts stand out at once, and the
  halving of a part too large for the line's road: a part the line refuses 413 `too-large` is cut in two, at a
  paragraph else a line, each half asked on its own and the two joined in order, a half with no answer leaving
  the part unanswered. Any other refusal leaves the part unanswered.
- **A translation run the agency did not answer is asked again, never ended:** a connection refused, reset or
  closed before the answer came, and a 503 the agency answers while it cannot take the run, are each followed
  by the same ask once a pause has passed, one second after the first and doubling to at most thirty, until the
  agency answers it or refuses it otherwise. An agency restarting under a run therefore costs the run its time
  and never its answer.
- **The gate's word on a part goes as its `note`,** which the line carries into the run untranslated: where an
  answer lost its part's structure, or a record's rendering ran its lists together, left English, changed a
  fenced block or used a banned term, the ask again names what was wrong with the last answer; and a record's
  one-line text — a title, a state line — is asked as one short line with no full stop the English does not
  have. A part the gate has no word on goes with no note.
- **What is the agency's:** the road each translation walked and what it spent, kept in the agency's ledger; the
  gate keeps of a document's translation only its rows and, where a part failed, why.

### The roads walked

The agency publishes the road each conversational turn walked as a `road-walked` event on its event stream (the
agency's `docs/api.md`, 「Events」, and its `docs/run-records.md`, 「The roads a turn walked」). Each frame
carries the event's number as its SSE id, and its data is the event, `{id, kind, at, data}`, its inner `data`
the road: `stage`, `chatId`, `run`, `provider`, `model`, `outcome`, `ms`, the four token counts and
`contextRatio`.

- **Each road is written into the gate's road records with its number,** the road record's `event`; a road
  record the gate writes for its own runs carries none.
- **The stream is read on from the newest number written.** It is opened with that number as `Last-Event-ID`,
  so the agency sends every road it published after it and then the live ones; a road whose number is not past
  the newest written is not written again. With no number written yet, it is opened with none and reads from
  then on. The newest number is read from the road records each time the service starts and followed in memory
  while it runs, so neither the agency's restart nor the gate's own loses a road the agency still keeps.
- **It is opened again five seconds after it drops,** whatever dropped it: the agency stopping, the connection
  broken, a refusal.
- **A road the agency no longer keeps** is told as `events.missed`; the gate says on its error stream which
  numbers were missed and reads on from what follows. Where the number the gate named is one the agency never
  gave, its numbering standing behind the gate's, every road sent after the notice is written whatever its
  number.

### The model gateway

A gate run on a registered model has no tools and no session: it is one request to the gateway's
`/v1/chat/completions`, the registration's name as its model, the gate's instructions as the first message,
the input, `max_tokens` and `enable_thinking` as the run says (the agency's `docs/own-llm.md`, 「A request with no
tools」, 「The gateway」). It names no wait: the request is waited for until the gateway answers or its connection
is refused or broken. The key is read from its file for each request.



### bmo-node

The GGUF engine's installer reaches a node by its registered name through the node unit's command, as the
tooling's settings name it (`docs/training.md`, 「The tooling and its settings」): `node --target <node>` prints the
node's connection as JSON (the node unit's `docs/nodes.md`, 「Registering and changing a node」), its connection
type with an ssh node's address, port, account, key path and shell, or a hub node's agent, hub and token file, and
its role. No credential is in it. A hub node is then driven through the node console the settings name, an ssh
node by a batch login (`docs/gguf-llm.md`).

## How a gate run reaches a model

Gate runs are the gate's own: the agency starts none and holds no gate's line. A translation is no gate run: the
gate asks the agency's translation line, which the agency runs as a run apart (「The translation line」). No gate
stands in the order, so no gate of a turn reaches a model. A run that a caller names goes on its one road, one ask
and nothing behind it (`docs/gates.md`, 「Where a gate's runs go out」):

- **The road** is the provider order of the role the gate's profile names: the role's active provider, else the
  first provider of its order that is on, with the model, the effort, the thinking and the answer ceiling the
  order's entry names there (`docs/gates.md`, 「Where a gate's runs go out」). A run its caller puts on another
  provider or on one registration goes there alone.
- **A provider whose program carries the run** — Claude Code, and any provider the agency does not mark
  `gateway` — is a thrown-away agency session each run: started apart on the provider and model, sent one
  turn with the gate's instructions as its whole system prompt, a fresh session, no tools, and thinking as
  the run asks. The gate knows no pane, no terminal and no backend.
- **A provider whose models the agency marks `gateway`** — the registry's registrations and the member
  roads of the providers agency carries on the gateway — is one request through the agency's model
  gateway, on the model the mapping names. A request the gateway refuses as past the model's window is cut
  by its caller where the caller can cut it, each part asked on its own, and is the gate having no answer
  otherwise.
- **A run waits for its place and for its answer.** A run past its gate's pool waits in line for a place however
  long that takes and goes out when one comes free; once out, it is waited for until its road answers, fails, or
  somebody stops it. No span of time ends a run, and a gate has no wait of its own.
- **Runs for different companies share no prompt prefix on any road.** A run whose caller names its `tenant`
  carries, as the first line of its material, a mark made from that name alone; an engine or a provider reuses a
  cached prefix only where the material agrees from its first token, so no company's material is answered faster
  for having been read for another. A run that names none — the platform's own rooms — carries no mark.
- **What a run walked** is written into the gate's road records, and what it spent is the agency's `usage-spent`.

## What the gate owns

### Its tables

`gate_options`, `gate_roads`, `judgements`, `reference_offers`, `reference_verdicts`,
`document_translations` and `web_gate_chats`, in its own database and its own migrations. Every row of
`gate_options` names its agent. `reference_offers` and `reference_verdicts` hold records the history reads
(`docs/api.md`, 「Judgements」) and nothing writes.

### Its gates and their instructions

- **The gate order** — which gates stand, the part and step each takes against a turn, and each gate's profile
  (whether it may be switched off, its answer floor) — is the gate's, and `GET /gates` serves it. It holds no gate.
- **The instructions:** no gate stands, so no gate carries instructions.

### The policy it reads

| Values | Owner | How the gate reads them |
|---|---|---|
| the gate pool: how many runs of one gate stand at once, the rest waiting in line | the gate | its own policy file |
| what a turn is handed: the sheet's head and ceiling, the org sheet's ceiling, the due memories' count, the woken rows' and the turn's totals | the gate | its own policy file |
| the memories entry's data lines | the gate | its own policy file |
| the org sheet's lines and the organisation group's words | the gate | its own policy file |
| the gate order and the gates' profiles | the gate | its own policy file, served by `GET /gates` |
| the prompt ceilings | the gate | its own policy file |
| the translator's languages: the worker's, the owner's and each language's name | the gate | its own policy file |
| the provider order a gate's runs go out on, each entry's model, effort, thinking and answer ceiling | the agency | `GET /roles/{roleName}`, the role the gate's profile names |
| the keepalive's ping bound | the agency | not read: a gate run keeps no session |
| a resident turn's shape | the agency | not read: a gate run is no resident turn |
| OpenRouter's settings | the agency | not read: a run reaches OpenRouter through the agency |
| filling a template's marks | none | the gate's own code |

## The unit command

`bmo-gate` is the gate's unit command (bmo-cli's `docs/boundary.md`, 「Unit commands」). Asked `nouns`, it
declares the nouns it carries, one a line. It carries one, `translate`, marked `home`: the mouth group's
first-class verb, which asks the running gate's `POST /translations` for the text in the language named. Its
own `health`, `records` and `import` are no noun.

| Noun | Words | What it asks |
|---|---|---|
| `translate` | `[--language <code>] [--text <words>]` | `POST /translations`; the words come from standard input where `--text` names none, and the language is `ko` where none is named; the first reading is printed |


- **Every command prints English** and ends with 0, with 1 where its work failed, and with 2 where the words it was
  given are wrong; `--help` prints a noun's whole usage.
- **It reads the settings the service reads** (「Configuration」): the file `BMO_GATE_SETTINGS` names, else
  `settings.toml` in the folder it runs in. A noun that reads nothing but its own files under the data root
  reads only the data root from them.
- **It is the gate's own,** so it reads the gate's database and data root as the service does, and reaches the
  other units only through the routes above. A command that reads another unit's records whose owner serves no
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
- **The brain's layers are listed by position but paged after the last id seen,** so a page boundary can
  pass over a layer whose id is lower than one already read. The gate reads the layers at the route's
  ceiling of a page and asks each later page after the largest id it has read, until the brain pages its
  layers in the order it lists them.
- **The upstreams' published clients do not carry the calls the gate makes.** bmo-brain's client serves memory
  rows, notes, watches, reminders, fragments and libraries, and not the subject, sheet and tally routes the gate
  reads. The gate's hand-written ports in `crates/ports` stand for these calls until their owners serve them,
  and the gate takes the client of each one as soon as it does; bmo-agency's client serves the role read, the
  sessions and the turns the gate's agency port makes, for the gate to take up.
- **The agency keeps a copy of the gate order:** its `policy/gates.toml` and the policy crate's module of it. Its
  gate switch route validates a gate's name against its own copy; the copy is for the agency to retire, reading
  the order through `GET /gates`.
- **The brain's knowledge read** answers the knowledge chunks a room may read; the gate reads a room rule's piece
  through it as well, for the brain to take the room's room-rule chunks there.
- **The receiver sends no `lore`** with a turn's reference, so every room's index lists the lore.
- **The document viewer counts a part kept as failed and says no more:** the parts page answers each such part's
  `failure` (`docs/api.md`, 「Documents」), for the web unit to show beside the count.
