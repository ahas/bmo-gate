# The gate's boundary

This document is the gate's boundary: every route it serves, every call it makes on another unit, the unit
command it carries, and what it owns. A unit reaches the gate only across it, and the gate reaches another
unit only by the calls below. A route or a call that is not here is not part of the boundary.

The gate is the gate stage of a turn. The receiver builds a turn's envelope; the gate sanitises the words on
their way into a model's context, picks the reference the turn is handed, and checks the answer on its way
out; the agency carries the turn; the brain serves the raw material the gate picks from. Beside a turn the
gate translates, seeks documents, judges person-book sheets and reads voice lines for the units that ask, and
it records every judgement it makes and the road each run walked. Laya, the decision filter some gates ask
first, is the gate's own service, reached through the gate's own relay.

## Configuration

The service reads one TOML file at start and holds it for its life: the release's own `settings.toml`, which
each release links to the data root's `env/gate.toml`. It names:

| Key | What it is |
|---|---|
| `listen` | the address the service answers at |
| `address` | the base address the service is reached at, which it hands the agency for its hook |
| `token_file` | the name of the file under the data root's `env/` holding the bearer token every caller presents |
| `database` | the address of the gate's own database, holding the tables under 「What the gate owns」 and nothing else |
| `data_root` | where the gate's runtime data lives: Laya's checkpoints, datasets and run output, and the gate's run files |
| `chat_agent` | the registration name whose gate options stand for the deployment, and which a companion's are copied from |
| `session_folder` | the folder a gate run's thrown-away session is started in |
| `owner_room` | the room a row the gate raises reports to |
| `[agency]`, `[brain]`, `[receiver]`, `[job]` | each unit's `address`, and the `token_file` under `env/` holding the token it is called with |
| `[arbiter]` | the card master's `address` |
| `[gateway]` | the agency's model gateway: its `address`, and the `key_file` under `env/` |
| `[laya]` | the gate's own Laya relay, where one stands: its `address`, and the `token_file` under `env/` |
| `[records]` | where the session summariser reads a closed session's record: `claude`, Claude Code's configuration folders searched in order, and `codex`, Codex's sessions folder |
| `[shipped]` | `folder`, under which the shipped pieces' bodies are read — the system's reference documents and the lore, as the deployment places them — a row's path read relative to it |
| `[reading]` | what the translator's checks read a text by: `set_aside`, the words the English test reads past — the names of people and agents and the marks a note's strands open with — and `wording`, the file the owner's banned words are read from, where the deployment keeps one |

No address, port, host, path or name of a deployment is written in the code; every one is read from here.

## Wire conventions

The gate serves route families in its callers' conventions, so each caller reads the gate as its own document
says:

| Family | Callers | Bodies | Refusal |
|---|---|---|---|
| the units' | bmo-receiver, bmo-job, bmo-artifact, the voice unit, the console's plugin bundle | JSON, snake_case | status and `{error, code}`, the code snake_case |
| the brain's | bmo-brain | JSON, camelCase, every route `POST` | a refusal is an answer: 200 with `answered` false and `refusal` (`code`, `message` and the code's own fields); a failure is status and `{error, code}`, the code kebab-case |
| the agency's hook | bmo-agency | `{point, ask}` in, `{answer}` out | none: a hook answers its point's default where it cannot answer |

- **Auth.** Every route takes `Authorization: Bearer <token>` with the gate's token, and answers 401 without
  it.
- **Numbers.** A room is its chat, a message its message number, a person their sender number: each a signed
  64-bit integer. Times are Unix seconds unless a route says otherwise.
- **No sentence a person reads goes out of the gate.** Every answer is data, codes and their fields, and an
  English sentence only where an error needs one. A screen's words are the console's language pack.
- **The refusal body** is two keys: `error`, one English sentence naming why, and `code`, a stable code a caller
  decides on. The one third key is `reason` beside `laya_mode_refused`, the code of the mode refusal it is. The
  codes are `docs/codes.md`.

| Status | When |
|---|---|
| 400 | the body or the query is wrong as asked |
| 401 | the token is missing or wrong |
| 404 | the route, the gate, the room or the trial named does not exist |
| 409 | the request conflicts with what stands, or the run it asked was stopped (`stopped`) |
| 500 | the gate failed while answering, its database among it (`database`) |
| 502 | a call the route needed on another unit failed (`unit_failed`, naming the unit) |
| 503 | the service is up but cannot answer yet (`not_ready`) |

## Routes served

### For bmo-receiver

As the receiver's `docs/boundary-api.md` states them in 「The gate」, and its gate port makes them.

| Route | Request | Answer |
|---|---|---|
| `POST /reference/selected` | `chat`, `message?`, `lines` (the room's recent messages in the room shape, each a string), `speakers` (the people whose words the turn answers), `situation?` (`agent`, `room`: `owner` or `group`, `events`: each `kind` and `item?`, `now`), `holds?` (names), `round?`, `people_spoke`, `answered?`, `off` (the gates switched off for the agent), `lore?` (whether the room reads the lore, as its tone says; true where absent), `records` | `entries`: each `path`, `text`, `source` (`document`, `person`, `rule`, `situation`, `knowledge`, `memory`, `room` or `archive`) |
| `POST /sanitised` | `text`, `label`, `chat?`, `message?` | `text`, `changed`; 409 `stopped` where its run was stopped |
| `POST /judgements` | `chat`, `message?`, `stage`, `verdict`, `detail?`, `ms?`, `round?` | 204 |
| `POST /judgements/attached` | `chat`, `message`, `since` | 204 |
| `POST /options/copied` | `agent` (the companion), `from` (the chat agent) | 204 |

- **A turn's reference** is the reference gates, the person-book search and the situation-rule matcher run
  over the envelope, each on its own road, and the pieces they pick read from the brain. A gate named in
  `off` is not asked. Where `records` is true the turn's offers and verdicts are written.
- **A judgement** is a decision written into a room's log: a round's skip, a re-ask, an answer sent. It is
  written as it comes, with the moment it was written.
- **The attach** puts a round's judgements under the message that answered it: every judgement of the room
  written at or after `since` and standing under no message yet is put under `message`. The receiver asks it
  once the answer is sent, `since` being the moment the round began.
- **A companion's gate options** are the `from` agent's rows copied as they stand, under the companion's name,
  so its gates run on the same options from its first turn and are tuned apart afterwards. A `from` with no rows
  copies nothing and is no refusal.

### For bmo-job

As bmo-job's `docs/api.md` states them in 「bmo-gate」, and its crate `job-gate` makes them.

| Route | Request | Answer |
|---|---|---|
| `POST /translations/kept/read` | `language`, `originals` | `kept`, each `original` and `text` |
| `POST /translations` | `language`, `originals` | `readings`, each `text` and `whole` |
| `PUT /translations/kept` | `language`, `original`, `text` | 204 |
| `POST /sanitised` | `text`, `label`, `chat?` | `text`, `changed`; 409 `stopped` |
| `POST /knowledge/selected` | `agent`, `chat`, `lines` | `pieces`, each `path` and `text` |

- **A language** is a language tag. A translation is kept under its original and its language, so the same
  original is never translated twice into one language.
- **Reading kept translations** never asks the translator; `kept` holds one entry for each original with a
  translation kept in the language.
- **Translating** answers one reading for each original, in the order given: an original with no part in
  another language stands as it is; any other has its parts in another language translated, each part
  standing beside the rest as it did, and is kept; a part the translator could not render stays in its
  original, the reading is not `whole`, and nothing is kept for it.
- **Keeping a translation** keeps `text` as the reading of `original` in the language, in place of any kept
  before.
- **The sanitiser** defuses the smallest spans that carry security-intrusion material and leaves the rest as it
  was. Words with nothing worth judging come back as they are; where the sanitiser has no answer, the words that
  made them worth judging are blanked, so they are never handed on raw. A verdict is kept under the message
  where `message` names one.
- **Selecting knowledge** picks, from the brain's libraries the agent may be offered in the room, the pieces a
  piece of work's own lines call for. The narrowing, the pick and the count of what was attached are the
  gate's.

### For bmo-artifact

As bmo-artifact's `docs/api.md` states it under 「bmo-gate」.

| Route | Request | Answer |
|---|---|---|
| `POST /knowledge/work` | `chat_id`, `lines` | `pieces`, each `path` and `text` |

The same pick as `POST /knowledge/selected`, for the chat agent: a search's work names its question as one
line. A pick that fails costs the run its reference and nothing else.

### For bmo-brain

As the brain's `docs/boundary-api.md` states them in 「The gate」, in the brain's conventions.

| Route | Body | Answer |
|---|---|---|
| `POST /sanitiser/documents` | `path`, `text` | `answered` true and `text`, or `answered` false and `refusal` naming why |
| `POST /sheets/judge` | `agent`, `part` (`common` or `room`), `chatId` (the room's, or null for the common part), `person`, `pieces` (each `path` and `text`), `ceiling`, `registration` or null | `sheet`, or null where none came |

- **A document's sanitising** reads the text an editor changed and answers the text to keep. Which texts need
  looking at is the gate's; a text with nothing worth judging comes back as it is.
- **A sheet's judgement** is the person-book summariser: one person's sheet of one part, written from the pieces
  handed in and held under `ceiling` characters, on the registration named where one is, else on the gate's own
  road.

### For bmo-agency: the session summariser

The gate answers the agency's `session-summariser` hook point (the agency's `docs/api.md`, 「Hooks」). It
registers `POST /hooks` with `point` `session-summariser`, its own address for the point and its token as it
starts, and answers:

| Route | Ask | Answer |
|---|---|---|
| `POST /hooks/session-summariser` | `point` and `ask`: `kind` (`chat`, `worker` or `switch`), `mode`, `sessionId?`, `cwd`, `account?`, `transcript?`, `ownNote?`, `chatId?` | `answer`: the whole note the next run is handed, or null |

The note's length, its wording and how a session is read are the summariser's. A summariser that fails answers
null, and nothing is carried over.

### For the chat units: the output gate

| Route | Request | Answer |
|---|---|---|
| `POST /formats/decided` | `chat`, `text` (one part of a reply, as the dialect divided it, in markdown) | `markup`: the markup the part goes out as, or null to send its plain text |

- **The output gate** (`docs/output-gate.md`) reads the part as the `telegram-html` dialect reads it, folds it where
  the gate says FOLD, and hands back the first candidate the structure check passes. Its decision is written into
  the room's log, and a candidate the check refuses is kept as a format case. It never fails a part: where it has
  no answer the part goes out open, and plain where nothing else is left.

### For the voice unit: the voice gates

| Route | Request | Answer |
|---|---|---|
| `POST /stages/{stage}/runs` | `prompt`, `system?`, `chat?`, `message?`, `agent?`, `thinking?` (true where absent), `alongside?` (false where absent) | `answer` (the gate's text, or null where its road gave none), `ms`; 409 `stopped` |

- **One run of one gate,** for a unit that reads the answer itself: the voice unit's reading gate and script
  polishing gate, `voice-reading` and `voice-polish`. The run goes on the stage's road with the stage's options
  and is recorded as a road like any gate run.
- **The instructions** are the stage's own where `system` is absent. A stage that is not a gate is 404
  `no_gate`; a stage switched off answers null without asking any road.

### For the console

The console's plugin bundle (`client/`, `docs/layout.md`, 「The console plugin bundle」) is served by the web
unit, and the bundle's own server routes, running in the console, call these. Times here are Unix seconds.

| Route | Request | Answer |
|---|---|---|
| `GET /gates` | | `gates`: each gate in the gate order, its `key`, its `part` (`pre`, `post` or `apart`), its `step`, its `condition` or null, and its profile: `switchable`, `laya_probe`, `default_laya_mode` and `answer_tokens` |
| `GET /options/{key}` | | `timeout_ms`, `laya_mode`, `laya_tau`, `laya_probe`, `switchable`, `enabled`, `laya_fallback`, `effective` (`thinking`, `answer_tokens`, `timeout_ms`, `laya_mode`, `laya_tau`) and `defaults` |
| `POST /options/{key}` | any of `timeout_ms`, `laya_mode`, `laya_tau`, `enabled`, `laya_fallback`; a Laya field sent null goes back to the default | `key`, `options`: the gate's route as a run reads it (`provider`, `model`, `laya`, `timeout_ms`, `set_at`) |
| `GET /rooms/{chat}/judgements?before=&limit=` | | `judgements`, newest first, each `id`, `chat`, `message`, `stage`, `verdict`, `detail`, `created_at`, `ms`, `round`, `roads` (each `id`, `provider`, `model`, `outcome`, `ms`, `tokens`: `input_tokens`, `output_tokens`, `cache_read_tokens` and `cache_write_tokens`, or null where the road kept none) and `offers` (each gate's `stage`, `held`, `asked`, `kept`: how many each rule kept, `item`, `keyword` and `person`, `capped`, and `rules`, the rules a candidate could be kept by, or null where it could be kept by all); and `has_more` |
| `POST /trials` | `stage`, `prompt`, `user` | the trial: `id`, `stage`, `user`, `prompt`, `answer` or null, `ms`, `created_at` |
| `GET /trials/{stage}?limit=` | | `trials`, oldest first, each as above |
| `GET /laya` | | `health` (`state`, `model`, `device`, `vram_bytes`, `load_ms`, `versions`, `address`, `check_ms`, `checked_at`, `answered_at`), `gates` (each `stage`, `mode`, `tau`, `agreement` or null, `checkpoint` or null, `refused`: each mode the gate may not run in, with its code), `modes` and `taus` |
| `POST /documents/sought` | `question`, `entries` (each `slug`, `line`, `group?`) | `picks`, the slugs chosen; 502 `no_answer` where the seeker gave none |
| `POST /documents/translations` | `document`, `version`, `target`, `parts`, `wanted` (each `part` and `text`) | 202 with `taken`, the parts queued |
| `GET /documents/translations/state?document=&target=` | | `pending`, `failure` (`reason`, `provider`, `model`) or null |
| `GET /documents/translations/parts?document=&version=&target=` | | `parts`, each `part`, `text` and `failed` |
| `GET /events` | | a server-sent event stream: `judgement` (a judgement as `POST /judgements` wrote it), `document-translation` (`document`, `detail`) and `laya` (Laya's health state or model moved) |

- **A gate's options** are its wait, its switch where its profile lets it be switched off, its Laya mode, τ and
  fallback LLM (`docs/laya.md`). What it thinks and how much it may answer are its tier's on its road, and a
  change naming either is refused `own_llm`.
- **A trial** puts one prompt to one gate as a turn would, records no judgement, and keeps the trial. A prompt is
  at most a million characters.
- **A page** of judgements or trials is a hundred where `limit` names none, and five hundred at most; `before` is
  the `id` the next page starts below.
- **A judgement's roads** are its stage's road records of the same round, or of the same message where either names
  no round, that fall within the time the judgement took, give or take five seconds; each road goes to one judgement.
  Its `offers` are the offers record of its round.
- **A translation of a document** is queued part by part; each part is kept once it comes back with its
  structure kept, asked once more where it lost it, and kept as failed where it lost it twice.

### Health

`GET /health` answers `version` (the service's version), `ready` (its database and its settings stand) and
`laya` (the relay's last answer: `up`, `down` or `off`).

`bmo-gate health` asks the service the settings name (「The unit command」), at its `address` with its own
token, waiting at most five seconds, and ends 0 where it answers ready and 1 where it does not, saying why. It is
the deployment's check rather than a noun, so `nouns` does not declare it.

## Calls the gate makes

### bmo-brain

In the brain's conventions (its `docs/boundary-api.md`, 「Wire conventions」): camelCase, every call `POST`, a
refusal an answer.

| Call | Route | Body | Answer |
|---|---|---|---|
| open standing rows | `/memory/standing` | `agent`, `chatId` | `rows` |
| conditional rows | `/memory/conditions` | `agent`, `chatId` | `rows`: `slug`, `condition`, `action` |
| matched rows written | `/memory/matched` | `agent`, `chatId`, `matched`, `spent` | `ok` |
| rows the events wake | `/memory/events` | `agent`, `chatId`, `events` (each `kind`, `item`) | `rows` |
| fragments offered | `/fragments/offer` | `agent`, `chatId`, `kinds` | `fragments` |
| fragments attached | `/fragments/hits` | `agent`, `chatId`, `attached` (each `kind`, `chatId`, `owner`, `slug`) | `ok` |
| knowledge read | `/knowledge/read` | `agent`, `chatId`, `slugs` | `documents`: `slug`, `path`, `text`, `version` |
| person book read | `/people/read` | `agent`, `chatId`, `senders`, `slugs` | `sheets` and `pieces` |
| owner room rules | `/room-rules/read` | `chatId` | `rules`: `id`, `subject`, `text` |
| a session's loads | `/sessions/loads` | `session` | `loads`: `path`, `version` |
| a room forgotten | `/rooms/forgotten` | `chatId` | `ok` |

The brain picks nothing: the gate narrows and picks among what these answer, and writes back only what it
attached and what it matched.

### bmo-receiver

The receiver's routes 「For the brain」, in the same conventions, which the gate reads its room facts through.

| Call | Route | Body | Answer |
|---|---|---|---|
| room titles | `/rooms/titles` | none | `rooms`: `chatId`, `title`, `senders` |
| roads | `/rooms/roads` | `chatId` | `kind` (`owner` or `group`), `oneToOne` |
| spoke between | `/rooms/spoke-between` | `chatId`, `person`, `from`, `to` | `spoke` |
| owner spoke | `/rooms/owner-spoke` | `chatId`, `person`, `before`, `seconds` | `owner`, `spoke` |
| display names | `/people/names` | `people` | `names`: `person`, `name` |
| waits on a happening | `/promises/waits` | `text` | `waits` |
| own number | `/rooms/own-number` | `agent`, `chatId` | `number`: the sender the agent's words stand under in the room, or null |
| owner notice | `/owner/notice` | `code` and its fields | `ok` |

The reference nouns of the unit command (「The unit command」) read a stored turn's message through the route the
receiver serves bmo-job, in its snake_case: `GET /rooms/{chat}/messages/{message}`, answering `sender?`,
`sender_name?`, `sent_at` and `text`, and 404 where the receiver keeps no such message.

The owner notice tells the chat agent in the owner's room a fact the gate raised, as a code and its fields:
`attachment-alarm` (`row`, `stage`, `piece`, `share`) where the attachments watch filed a row
(「bmo-job」 below).

### bmo-agency

In the agency's conventions (its `docs/api.md`): camelCase, the agency's control token.

| Call | Route | What the gate needs it for |
|---|---|---|
| the agents | `GET /agents` | the registrations a gate run names and the agents a turn is for |
| shared rulebooks | `GET /rulebooks?names=` | `plain-writing` and `recollection`, the rulebooks the translator's record and the session summariser stand on |
| the providers | `GET /providers` | the provider order a gate's road begins on and whether each is on |
| a gate's route | `GET /fallback` | the run mode the gate's work key stands on, Laya among the modes |
| a mapping | `POST /routes/resolve` | `workKey`, `provider?`, `tier`: the `provider`, `model`, `effort` and `answerTokens` a gate run goes out on |
| a stand-in | `GET /stand-in?agent=` | whether a stand-in answers while Claude Code's road is closed |
| a session | `POST /session/start` | `agent`, `scope` `{kind: apart, provider, model, cwd, todo: null, role: null}`: one thrown-away session for one gate run on a provider's program |
| a turn | `POST /session/turn` | `session`, `prompt`, and the work parts: `provider`, `model`, `mapping`, `resume` `{kind: fresh}`, `name`, `work_key`, `chat`, `system`, the gate's whole system prompt, and `thinking`, whether the run thinks |
| a run stopped | `POST /runs/stop` | a run of the gate's somebody stopped |
| the events | `GET /events?kinds=road-walked` | the road each conversational turn walked, which the gate writes into its road records |
| a hook registered | `POST /hooks` | `point` `session-summariser`, `url`, `token` |

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

### bmo-job

| Call | Route | Body | Answer |
|---|---|---|---|
| a row raised | `POST /todos/raised` | `title`, `judgement`, `chat`, `key` | `id`, `raised` |

The attachments watch raises a row where one reference piece attached on more than its share of a gate's turns
over the last day and its latest half, so a job finds why; the owner's room hears of it through the receiver's
owner notice, code `attachment-alarm` with `row`, `title`, `stage`, `slug` and both shares. `key` names the piece:
while the row last raised under it is neither done nor deleted, bmo-job answers that row's `id` with `raised` false
and raises nothing.

## How a gate run reaches a model

Gate runs are the gate's own: the agency starts none and holds no gate's line. A gate runs on its one road, one
ask and nothing behind it (the agency's `docs/own-llm.md`, 「A gate has one road」):

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
`reference_verdicts`, `sanitised_texts`, `document_translations`, `format_cases` and `web_gate_chats`, in its own
database and its own migrations. Every row of `gate_options` names its agent. A format case and a sanitiser's
verdict are kept ninety days: the service sweeps both tables as it starts and once a day after.

### Its gates and their instructions

- **The gate order** — which gates stand, the part and step each takes against a turn, and each gate's profile
  (whether it may be switched off, its Laya probe and default mode, its answer floor) — is the gate's, and
  `GET /gates` serves it.
- **The instructions,** sixteen files in thirteen folders, one folder a gate: `sanitizer`, `situation-rules`,
  `document-seek`, `system-documents`, `room-rules`, `library-knowledge`, `people-search`, `people-standing`,
  `translator` (three), `output-gate/telegram-html`, `session-summary` (two), `voice-reading` and
  `voice-polish`. A prompt told its own ceiling (the person-book search's and the document seeker's) is rendered
  with the ceiling the gate's run holds to.

### The policy it reads

| Values | Owner | How the gate reads them |
|---|---|---|
| the document seeker's caps | the gate | its own policy file |
| the gate pool: how many runs of one gate stand at once | the gate | its own policy file |
| the output gate's folding dialects and checks | the gate | its own policy file |
| the reference gates' libraries, caps and rules | the gate | its own policy file |
| the memory rows a turn is handed: their caps and order | the gate | its own policy file |
| the session summariser's note: its length and parts | the gate | its own policy file |
| the gate order and the gates' profiles | the gate | its own policy file, served by `GET /gates` |
| the prompt ceilings | the gate | its own policy file |
| a work key's tier, mapping and run mode | the agency | `POST /routes/resolve`, `GET /fallback` |
| the keepalive's ping bound | the agency | not read: a gate run keeps no session |
| a resident turn's shape | the agency | not read: a gate run is no resident turn |
| OpenRouter's settings | the agency | not read: a run reaches OpenRouter through the agency |
| filling a template's marks | none | the gate's own code |

## The unit command

`bmo-gate` is the gate's unit command (bmo-cli's `docs/boundary.md`, 「Unit commands」). Asked `nouns`, it
declares the nouns it carries, one a line. These are its ten nouns:

| Noun | What it does |
|---|---|
| `gate eval` | runs the gate evaluation set over a gate and scores it |
| `gate bench` | benches a gate's road against recorded turns |
| `gate laya-agreement` | counts each Laya gate's agreement with its LLM |
| `gate format-cases` | reads the output gate's format failure cases |
| `reference compare` | compares two reference picks over recorded turns |
| `reference inputs` | prints the input the reference gates are handed for a turn |
| `reference narrowing` | measures the narrowing before the reference gates |
| `reference replay` | replays recorded turns through the reference gates |
| `reference roads` | compares the reference gates' roads |
| `reference waste` | counts the reference attached and never used |

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

- **The agency's thrown-away session** carries no part for a whole system prompt or for thinking off; the gate
  sends `system` and `thinking` with the turn's work parts, for the agency to deliver as the program's whole
  system prompt and its thinking.
- **The agency's session summariser hook** hands a Claude Code or Codex session by its id alone, with no
  `transcript`; the summariser reads the session's record from the folders its `[records]` settings name, on
  the machine both run on, until the agency hands the transcript itself.
- **The agency's `GET /fallback`** does not state, in its document, the fields of a work key's run mode the gate
  reads.
- **The agency keeps copies of gate-owned files:** the gate order (its `policy/gates.toml` and the policy crate's
  module of it), the prompt ceilings (its `policy/gate-prompts.toml` and its module), and fourteen of the gate's
  instruction files under its `prompts/agents/`: `sanitizer`, `situation-rules`, `document-seek`,
  `system-documents`, `room-rules`, `library-knowledge`, `people-search`, `people-standing`, `translator`
  (three), `output-gate/telegram-html`, `voice-reading` and `voice-polish`. Its gate switch route validates a
  gate's name against its own copy of the order; the copies are for the agency to retire, reading the order
  through `GET /gates`.
- **No chat unit asks the output gate yet:** the telegram unit's send path folds a reply's parts by its own
  code; it is to ask `POST /formats/decided` for each part where the send asks for the gate.
- **The brain's knowledge read** answers the knowledge chunks a room may be offered; the gate reads a picked
  room-rule chunk's body through it as well, for the brain to take the room's room-rule chunks there.
- **The receiver sends no `lore`** with a turn's reference; a room's tone is in its persona file, which the
  receiver reads, and it is to send false for a room whose tone reads no lore.
- **bmo-job serves no route for a row another unit raises;** the gate makes `POST /todos/raised` as written
  above, and bmo-job refuses it until it adds the route.
- **The web unit's console** shows the gates' screen, Laya and the gate order as unavailable; its server routes
  are to hand the gates' screen to `client/` and call the console's routes above.
- **The voice unit serves no reading of a line's script:** the evaluation set's voice members read an item as the
  voice runner makes a line's script, its spans and its polishing view, which are the voice unit's rules, so
  `voice-polish` and `voice-reading` have no member until the voice unit serves that reading
  (`docs/gate-eval.md`, 「The members」).
- **The receiver serves no route for a room's latest messages:** the output gate's replay bench makes its set out
  of the chat agent's latest answers, and says the source is unavailable until the receiver serves them
  (`docs/output-gate.md`, 「The replay bench」).
- **The receiver names bmo-job alone as the reader of a stored message:** the reference nouns read one through
  the same route (「bmo-receiver」 above), for the receiver to name the gate beside bmo-job.
- **No unit serves what the reference nouns read beyond that** (`docs/reference-selection.md`, 「What it picks and
  what it costs, measured」): the agency lists no agent's runs out of its run log, so `reference compare` reads
  the stored runs it is handed; the brain serves its rows and not its index files, so `reference roads` sets
  the index files beside the rows for the shipped pieces alone; and no unit keeps the usage record, so `reference
  waste` gives no size for a turn's own prompt.
