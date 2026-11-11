# The gate's API

**Fixed at 0.1.0-rev.1.** This document and `docs/openapi.json` are the gate's canonical public API. The
OpenAPI document is generated from the contract's own types and a test fails where the committed document
differs from what the code generates. The Rust crate `bmo-gate-client` and the TypeScript package under
`package/` are made from that one document; a caller uses them and writes no client of its own.

The wire format and the API design rules are the common ones of bmo-chat's `docs/conventions.md`; this
document states only what is the gate's. Every route is grouped by the resource it acts on, and no section is
written for one caller.

## Common rules

- **Auth.** Every route takes `Authorization: Bearer <token>`; a missing or wrong token is 401 `unauthorized`.
- **Keys** are camelCase. **Times** are one integer of epoch milliseconds. **Ids** are signed 64-bit integers:
  a room is `roomId`, a message `messageId`, a person `personId`.
- **Pages** are `{"items": [...], "more": boolean}`. A list takes one cursor, `before` or `after`, and
  `limit`: 100 where none is given, at most 500.
- **Errors** are a non-2xx status and `{"code", "error"}`, the code kebab-case and stable, the error one
  English sentence. A refusal is answered by status too; no 2xx carries a refusal flag.
- **The gate names no caller.** A gate is `gateName`, an agent `agentName`; both are the names the caller
  registered, and the gate reads no meaning into either.
- **No personal data** enters a route or an answer beyond the opaque ids and names a caller hands over.

## Health

`GET /health` answers `ready`, `reason` (null when ready) and `version`.

## Gates

| Route | Request | Answer |
|---|---|---|
| `GET /gates` | | a page of the gate order, each `gateName`, `part` (`pre`, `post` or `apart`), `step`, `condition` or null, `switchable` and `answerTokens`; the order holds no gate, so the page is empty |
| `GET /options/{gateName}` | | `switchable`, `enabled`, `effective` (`thinking`, `answerTokens`) and `defaults` |
| `POST /options/{gateName}` | `enabled` | `gateName` and `options`, the gate's road as a run reads it (`provider` and `model`, `docs/gates.md`, 「Where a gate's runs go out」) and `setAt`, the moment the change was written |
| `POST /options/{gateName}/agents/{agentName}` | as `POST /options/{gateName}` | as `POST /options/{gateName}`, its switch the agent's |
| `POST /options/copied` | `agentName` (the companion), `fromAgentName` (the chat agent) | 204 |

- **A gate's options** are its switch where its profile lets it be switched off. What it thinks and how much it
  may answer are its role's on its road; a change naming either is refused `own-llm`. A gate has no wait of its
  own: a run is waited for until it ends (「Runs」). No gate stands in the order, so no options row is read or
  written.
- **A change names whose options it writes.** `POST /options/{gateName}` writes the chat agent's row of the gate;
  `POST /options/{gateName}/agents/{agentName}` writes the named agent's, with the same fields and refusals, and
  no other agent's row is touched by either.
- **Copying options** writes the `fromAgentName` agent's rows under `agentName` as they stand, so the
  companion's gates run on the same options from its first turn. An agent with no rows copies nothing and is
  no refusal.

## Judgements

| Route | Request | Answer |
|---|---|---|
| `GET /judgements` | `roomId`, `gateName`, `from` and `to` (epoch milliseconds) narrow the list; `before` and `limit` page it, newest first | a page of judgements |
| `POST /judgements` | `roomId`, `messageId?`, `gateName`, `verdict`, `detail?`, `ms?`, `round?` | 201, the judgement as written |
| `POST /judgements/attached` | `roomId`, `messageId`, `since` (epoch milliseconds) | 204 |

- **A judgement** is a decision written into a room's log: a round's skip, a re-ask, an answer sent. It is
  written as it comes, with the moment it was written.
- **A judgement's `lines`** are what a gate's model was asked of its candidates, each `line` exactly as the model
  read it and its `answer`, null where the answer was not read, where the judgement keeps them. They are empty on
  every other judgement and on one written by `POST`.
- **A judgement's roads** are its gate's road records of the same round, or of the same message where either
  names no round, that fall within the time the judgement took, give or take five seconds; each road goes to
  one judgement. Its `offers` are the offers record of its round. Both are empty on a judgement as `POST`
  answers it and filled on a judgement as `GET` answers it.
- **The `draft` stage is the gate's own:** it writes those judgements itself, of the receiver's round log
  (`docs/gates.md`, 「What a turn records」), and they are read and attached like any other.
- **The attach** puts a round's judgements under the message that answered it: every judgement of the room
  written at or after `since` and standing under no message yet is put under `messageId`. A caller asks it
  once the answer is sent, `since` being the moment the round began.

## Reference

`POST /reference/selected` takes a turn's envelope:

| Field | What it is |
|---|---|
| `roomId` | the room |
| `messageId?` | the message the turn is about |
| `lines` | the room's recent messages in the room shape, each a string |
| `speakerIds` | the people whose words the turn answers |
| `situation?` | `agentName`, `roomKind` (`owner` or `group`), `events` (each `kind` and `itemId?`), `nowAt` |
| `holds?` | names the turn is held to |
| `round?` | the round the turn belongs to |
| `peopleSpoke` | whether anyone spoke |
| `answered?` | the answer already sent, where one was |
| `records` | whether the turn's offers and verdicts are written |

It answers `entries`, each `path`, `text` and `source` (`document`, `person`, `rule`, `situation`,
`knowledge`, `memory`, `room` or `archive`).

- **A turn's reference** is what attaches with no pick (`docs/reference-selection.md`, 「What a turn is
  given」): the head of each speaker's sheet, at most three due memories and the rows the turn's events wake. It
  asks no model. The envelope is read for the room, the speakers, the agent and the events; its other fields
  change nothing a turn is given.

| Route | Query | Answer |
|---|---|---|
| `GET /reference/index` | `session?`, `room`, `agent?` | `groups`, each `group`, `unread`, `hint` (or null) and `entries`, each `slug`, `holds`, `readWhen` (or null) and `path`, the path a piece read of it is recorded under among the session's loads |
| `GET /reference/pieces/{slug}` | `room`, `group`, `session?`, `agent?` | `slug`, `group`, `path`, `text` |
| `GET /reference/search` | `q`, `room`, `limit?` (8 where absent, at most 24), `agent?` | `entries`, each `slug`, `group`, `holds`, `readWhen` (or null) |

- **The index, a piece and a search** are the brain's reference as the agent reads it itself, with no model
  (`docs/reference-selection.md`, 「The index an agent reads」). `group` is `system-documents`, `room-rules`,
  `knowledge`, `people` or `room-memories`; any other is 400 `bad-request`, as is a `limit` outside 1 to 24 or an
  empty `q`. An index asked with no `session` counts every entry unread. A slug its group does not hold is 404
  `not-found`. A piece read with `session` is recorded among the
  session's loads; a call on the agency that fails is 502 `upstream-failed`.

## Translations

| Route | Request | Answer |
|---|---|---|
| `POST /translations` | `language`, `originals` | `readings`, each `text` and `whole` |
| `GET /translations/kept` | `language`, `originals` (a comma-separated list) | a page of `original` and `text` |
| `PUT /translations/kept` | `language`, `original`, `text` | 200, the translation kept |

- **A language** is a language tag. A translation is kept under its original and its language, so the same
  original is never translated twice into one language.
- **The translator takes two languages,** each the gate's policy's (its translation part), so a deployment whose
  owner reads another language changes the policy and no code: the language a worker reads, which the worker
  instructions put a text into, and the owner's language, which the record instructions put a text into and a
  record's checks hold it to. Any other language is 422 `language-unknown`.
- **Reading kept translations** never asks the translator; the page holds one entry for each original with a
  translation kept in the language.
- **Translating** answers one reading for each original, in the order given: an original with no part in
  another language stands as it is; any other has its parts in another language translated, each part
  standing beside the rest as it did, and is kept; a part the translator could not render stays in its
  original, the reading is not `whole`, and nothing is kept for it. The answer is the whole call's, given once
  every original is read.
- **One call carries at most 16 originals;** more is 400 `too-many-originals`, and a caller with more asks again
  for the rest.
- **The translator's work is queued, not refused.** The parts in another language of every call standing go to
  the agency's translation line together (`docs/boundary-api.md`, 「The translation line」), no more at once than
  the translation policy's bound, four (`lanes`), and a part waits its turn behind those asked before it,
  whichever call it came in.
  At most 64 originals stand at once across the calls, read or waiting; a call that would take the count past
  that waits in line, nothing of it read, until enough of those standing are answered, however long that takes.
- **Keeping a translation** keeps `text` as the reading of `original` in the language, in place of any kept
  before.

## Runs

`POST /stages/{gateName}/runs` takes `prompt`, `system?`, `roomId?`, `messageId?`, `agentName?`, `thinking?`
(true where absent), `alongside?` (false where absent) and `tenant?`, the company the run is for, as the caller
names it. It answers `answer` (the gate's text, or null where
its road gave none) and `ms`.

- **One run of one gate,** for a unit that reads the answer itself. The run goes on the gate's road with the
  gate's options and is recorded as a road like any gate run.
- **A run is waited for until it ends:** its road answers, fails, or somebody stops it. No span of time ends a
  run or the wait for its place in the gate's pool (`docs/boundary-api.md`, 「How a gate run reaches a model」),
  so the call is answered when the run is.
- **The instructions** are the gate's own where `system` is absent. A name that is not a gate is 404
  `no-gate`; a gate switched off answers null without asking any road.

## Trials

| Route | Request | Answer |
|---|---|---|
| `GET /trials` | `gateName`, `after` or `before`, `limit`; oldest first | a page of trials |
| `POST /trials` | `gateName`, `prompt`, `userName` | 201, the trial |

A trial is `id`, `gateName`, `userName`, `prompt`, `answer` or null, `ms` and `createdAt`. It puts one prompt
to one gate as a turn would, records no judgement, and keeps the trial. A prompt is at most a million
characters; a longer one is 413 `too-large`.

## Documents

| Route | Request | Answer |
|---|---|---|
| `POST /documents/translations` | `document`, `version`, `target`, `partCount`, `wanted` (each `part` and `text`) | 202 with `taken`, the parts queued |
| `GET /documents/translations/state` | `document`, `target` | `pending`, `failure` (`reason`, `provider`, `model`) or null |
| `GET /documents/translations/parts` | `document`, `version`, `target` | a page of `part`, `text`, `failed` and `failure` |

- **A translation of a document** is queued part by part; each part is kept once it comes back with its
  structure kept, asked once more where it lost it, and kept as failed where it lost it twice, its `failure`
  saying in a sentence what the last answer lost; a part that did not fail has no `failure`.
- **A part's structure** is its headings at each depth, its blocks in their order and every inline code span
  word for word. The blocks are what a CommonMark reader with GitHub's extensions finds: each heading,
  paragraph, list item, table, block quote, code block and break. A blank line added or dropped between a
  heading or a list and the words beside it leaves the blocks as they were, and a paragraph's lines wrapped
  anew leave it one paragraph; a line of the translator's own beside the translation, a block dropped or two
  run into one does not. A worker's text read into the worker's language (「Translations」) is held to the same
  structure.
- A document name is a root and a path, a `/` between them; anything else is 422 `document-unknown`. A target
  is a language the policy's translation part names, by its tag, with the name the translator is asked for it by;
  any other is 422 `language-unknown`.

## Events

`GET /events` is the gate's one stream, as server-sent events. An event's `event` field is its kind and its
`id` field its number; its data is `{"id", "kind", "at", "data"}`, the inner `data` being the member the
event tells of. The kinds are `judgement.created` and `document-translation.changed`. A
reader that falls behind loses what it missed and reads the collections again.

## The tools a tool host places

The gate is offered to an agent as two tools the tool host places: `tools/translate` and `tools/reference`, each a
folder with its own `tool.toml`, placed with the tool host and registered as the gate's own by the deployment
(`docs/layout.md`, 「The deployment」). Each speaks version 1 of the tool host's call protocol (the tool host's
`docs/api.md`, 「The call protocol」), a process a call.

| Entry | Capability | Reached by | What it does |
|---|---|---|---|
| `gate/translate` | `gate.translate` | `call`: it is read-only | Translates `texts` into `language` through `POST /translations` (「Translations」) and answers the readings |
| `gate/reference_index` | `gate.reference` | `call`: it is read-only | The brain's index for `room` and the call's session, through `GET /reference/index` (「Reference」) |
| `gate/reference_piece` | `gate.reference` | `call` | One piece by `slug` and `group` in `room`, through `GET /reference/pieces/{slug}`, recorded among the session's loads |
| `gate/reference_search` | `gate.reference` | `call`: it is read-only | The entries whose words match `query` in `room`, at most `limit`, through `GET /reference/search` |

- **The reference tools read the turn from the call's record** (the agency's `docs/tools.md`): the agent from
  `BMO_TURN_AGENT`, the room from `BMO_TURN_CHAT` where the call names none, and the session from
  `BMO_TURN_SESSION` where the record carries it; each is passed to the gate where it stands. A call with no room
  named and none in the record is refused.
- **Their answers** are the gate's, as the result's structured content and its one text piece, and their refusals
  are told as the translator's are.
- **A call waits for the gate's answer** however long it takes: the manifests name no timeout, and the tool host
  keeps no clock on a call (its `docs/api.md`, 「The manifest」).

- **Its input** is `language`, a language tag, and `texts`, one text or several, at most sixteen, the most one
  translation carries (「Translations」). It is handed on to the gate as the translation's `language` and
  `originals`, so a translation kept before is answered without the translator, and every translation made is
  kept.
- **Its answer** is the gate's: `readings`, one for each text in the order given, each `text` and `whole`. It stands
  as the result's structured content and, the same JSON, as its one text piece.
- **A refusal** is a result marked `isError` whose text names the status, the code and the gate's sentence, as for a
  language the translator does not take. A gate that could not be reached or answered something unreadable, and a
  record that names no gate, answer their reason after `ERROR: `.
- **The entry declares no grant,** so a call is checked against the record's capabilities alone; its manual is
  `tools/translate/manual.md`.

### What a placed tool reads of its record

Of the session record a call is handed (the tool host's `docs/api.md`, 「The session record」) the tool reads only
its `variables`. Each variable below is read from them, or from the call's environment where they name none, which
the host lays from its `--pass-env` and the record's `variablesFile`:

| Variable | Meaning |
|---|---|
| `BMO_GATE_URL` | The gate's base address |
| `BMO_GATE_TOKEN` | The bearer token the gate takes from every caller (「Common rules」) |
| `BMO_GATE_TOKEN_FILE` | A file holding that token, read where `BMO_GATE_TOKEN` is named nowhere |

A record that carries the namespace `gate` and the capability `gate.translate` therefore carries `BMO_GATE_URL` and
one of the two token variables, or the host passes them on. A call that finds no address or no token answers its
reason after `ERROR: `, naming the variable.

## The document

`docs/openapi.json` is the machine form of this contract: every route, its body, its query, its answers and
the codes it can answer with. It is generated by `cargo run -p bmo-gate-client --bin gate-openapi`, and
`tests/api.rs` fails where the committed file and the generated one differ. The Rust crate
`crates/client` and the TypeScript package under `package/` are its two clients.
